import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFleetStatus } from "./status.js";

export interface ServerOptions {
  repoRoot: string;
  port?: number;
  host?: string;
  logger?: (m: string) => void;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// web/ sits next to src/ in the repo, and next to dist/ when built.
const WEB_DIR = path.resolve(here, "..", "web");

/**
 * Dependency-free dashboard: serves a single static page plus a JSON status API
 * the page polls. Read-only over the orchestrator's .harness state.
 */
export function startServer(opts: ServerOptions): http.Server {
  const port = opts.port ?? 4317;
  const host = opts.host ?? "127.0.0.1";
  const log = opts.logger ?? console.log;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (url.pathname === "/api/status") {
        const status = await readFleetStatus(opts.repoRoot);
        send(res, 200, "application/json", JSON.stringify(status));
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const html = await readFile(path.join(WEB_DIR, "index.html"), "utf8");
        send(res, 200, "text/html; charset=utf-8", html);
        return;
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
