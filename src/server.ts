import http from "node:http";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { openSync, closeSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFleetStatus } from "./status.js";
import { readAgentLog } from "./transcript.js";
import { InboxManager, type InboxKind } from "./inbox.js";

export interface ServerOptions {
  repoRoot: string;
  port?: number;
  host?: string;
  logger?: (m: string) => void;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// web/ sits next to src/ in the repo, and next to dist/ when built.
const WEB_DIR = path.resolve(here, "..", "web");
// Harness package root — cwd for re-spawned CLI commands so the tsx loader
// (passed via this process's execArgv) resolves from harness node_modules.
const HARNESS_ROOT = path.resolve(here, "..");

/** Spawn another harness CLI command the same way this process was launched
 *  (reusing node + its --import flags + the cli entrypoint). */
function spawnHarness(
  repoRoot: string,
  args: string[],
  logName: string,
  detached: boolean,
): ChildProcess {
  const harnessDir = path.join(repoRoot, ".harness");
  mkdirSync(harnessDir, { recursive: true });
  const fd = openSync(path.join(harnessDir, logName), "a");
  const cliPath = process.argv[1] ?? "";
  const options: SpawnOptions = {
    cwd: HARNESS_ROOT,
    detached,
    stdio: ["ignore", fd, fd],
    env: process.env,
  };
  const child = spawn(process.execPath, [...process.execArgv, cliPath, ...args], options);
  closeSync(fd);
  if (detached) child.unref();
  return child;
}

function slugBranch(desc: string): string {
  const slug = String(desc)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "task";
  const suffix = Date.now().toString(36).slice(-4);
  return `agent/${slug}-${suffix}`;
}

function sanitizeBranch(b: unknown): string {
  return String(b ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._/-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

// In-memory guard so the dashboard can't launch overlapping integration runs.
let integrating = false;

/**
 * Dependency-free dashboard: serves a single static page plus a JSON status API
 * the page polls. Read-only over the orchestrator's .harness state.
 */
export function startServer(opts: ServerOptions): http.Server {
  const port = opts.port ?? 4317;
  const host = opts.host ?? "127.0.0.1";
  const log = opts.logger ?? console.log;

  const inbox = new InboxManager(opts.repoRoot);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "POST" && url.pathname === "/api/inject") {
        const body = await readBody(req);
        const { branch, text } = JSON.parse(body || "{}");
        if (!branch || !text) return send(res, 400, "application/json", '{"error":"branch and text required"}');
        await inbox.post(branch, { kind: "inject", text, from: "dashboard" });
        log(`inject → ${branch}: ${String(text).slice(0, 60)}`);
        return send(res, 200, "application/json", '{"ok":true}');
      }

      if (req.method === "POST" && url.pathname === "/api/control") {
        const body = await readBody(req);
        const { branch, action } = JSON.parse(body || "{}");
        const allowed: InboxKind[] = ["pause", "resume", "end"];
        if (!branch || !allowed.includes(action)) {
          return send(res, 400, "application/json", '{"error":"branch and action (pause|resume|end) required"}');
        }
        await inbox.post(branch, { kind: action, from: "dashboard" });
        log(`control → ${branch}: ${action}`);
        return send(res, 200, "application/json", '{"ok":true}');
      }

      if (req.method === "POST" && url.pathname === "/api/integrate") {
        if (integrating) {
          return send(res, 409, "application/json", '{"error":"integration already running"}');
        }
        const body = await readBody(req);
        const { test, maxRounds } = JSON.parse(body || "{}");
        const args = ["integrate", "--repo", opts.repoRoot, "--dangerous"];
        if (test && String(test).trim()) args.push("--test", String(test).trim());
        if (maxRounds) args.push("--max-rounds", String(parseInt(String(maxRounds), 10) || 3));
        integrating = true;
        const child = spawnHarness(opts.repoRoot, args, "integrate.log", false);
        child.on("exit", () => { integrating = false; });
        child.on("error", () => { integrating = false; });
        log(`integrate started${test ? ` (test: ${String(test).slice(0, 40)})` : " (textual-only)"}`);
        return send(res, 200, "application/json", '{"ok":true,"started":true}');
      }

      if (req.method === "POST" && url.pathname === "/api/spawn") {
        const body = await readBody(req);
        const { description, branch } = JSON.parse(body || "{}");
        if (!description || !String(description).trim()) {
          return send(res, 400, "application/json", '{"error":"description required"}');
        }
        const wanted = sanitizeBranch(branch);
        const finalBranch = wanted || slugBranch(description);
        const task = {
          id: finalBranch.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "task",
          branch: finalBranch,
          description: String(description),
        };
        const tasksFile = path.join(os.tmpdir(), `harness-spawn-${Date.now().toString(36)}.json`);
        await writeFile(tasksFile, JSON.stringify({ concurrency: 1, tasks: [task] }, null, 2));
        spawnHarness(
          opts.repoRoot,
          ["run", tasksFile, "--repo", opts.repoRoot, "--concurrency", "1", "--dangerous"],
          "spawn.log",
          true,
        );
        log(`spawned worker on ${finalBranch}`);
        return send(res, 200, "application/json", JSON.stringify({ ok: true, branch: finalBranch }));
      }

      if (url.pathname === "/api/status") {
        const status = await readFleetStatus(opts.repoRoot);
        return send(res, 200, "application/json", JSON.stringify({ ...status, integrating }));
      }
      if (url.pathname === "/api/log") {
        const branch = url.searchParams.get("branch") ?? "";
        const offset = Number(url.searchParams.get("offset") ?? "0") || 0;
        if (!branch) return send(res, 400, "application/json", '{"error":"branch required"}');
        const chunk = await readAgentLog(opts.repoRoot, branch, offset);
        return send(res, 200, "application/json", JSON.stringify(chunk));
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await readFile(path.join(WEB_DIR, "index.html"), "utf8");
        return send(res, 200, "text/html; charset=utf-8", html);
      }
      send(res, 404, "text/plain", "not found");
    } catch (err) {
      send(res, 500, "text/plain", String(err));
    }
  });

  server.listen(port, host, () => {
    log(`harness dashboard → http://${host}:${port}  (repo: ${opts.repoRoot})`);
  });
  return server;
}

function send(res: http.ServerResponse, code: number, type: string, body: string): void {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
