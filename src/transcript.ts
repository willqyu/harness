import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Live agent transcript reader for the dashboard.
 *
 * Each worker is a Claude Code session running in its branch worktree, and
 * Claude Code streams a full transcript (thinking, assistant text, tool calls)
 * to `~/.claude/projects/<encoded-cwd>/<session>.jsonl`. We tail that file so the
 * dashboard can show an agent's reasoning live — no worker-side changes needed.
 */

export interface LogEvent {
  kind: "thinking" | "text" | "tool" | "result" | "user";
  text: string;
}

export interface LogChunk {
  /** Byte offset to pass back next poll for incremental reads. */
  offset: number;
  events: LogEvent[];
  /** True while the worktree's transcript exists (agent has/had a session). */
  found: boolean;
}

/** Claude Code encodes a session's cwd into its project-dir name by replacing
 *  path separators and `.`/`_` with `-` (e.g. /a/.b/c_d -> -a--b-c-d). */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/._]/g, "-");
}

/** Where the orchestrator places a branch's worktree (mirror of WorktreeManager). */
function worktreePath(repoRoot: string, branch: string): string {
  const safe = branch.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(repoRoot, ".harness", "worktrees", safe);
}

async function newestTranscript(projectDir: string): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return null;
  }
  let best: { f: string; m: number } | null = null;
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const s = await stat(path.join(projectDir, f));
      if (!best || s.mtimeMs > best.m) best = { f, m: s.mtimeMs };
    } catch {
      /* skip */
    }
  }
  return best ? path.join(projectDir, best.f) : null;
}

function clip(s: unknown, n = 2000): string {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n) + " …" : str;
}

function toolArg(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v =
    i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.description ?? i.prompt;
  return v ? clip(v, 200) : "";
}

/** Extract human-readable events from one transcript line. */
function eventsFromLine(o: any): LogEvent[] {
  const out: LogEvent[] = [];
  const type = o?.type;
  const content = o?.message?.content;

  if (type === "assistant" && Array.isArray(content)) {
    for (const b of content) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "thinking") {
        // Extended thinking is often redacted at rest (empty text + signature);
        // show the content when present, else a marker so the reasoning cadence
        // is still visible in the stream.
        const t = String(b.thinking ?? "").trim();
        out.push({ kind: "thinking", text: t ? clip(t) : "(thinking…)" });
      } else if (b.type === "text" && b.text) out.push({ kind: "text", text: clip(b.text) });
      else if (b.type === "tool_use") {
        const arg = toolArg(b.input);
        out.push({ kind: "tool", text: clip(`${b.name || "tool"}${arg ? " · " + arg : ""}`, 240) });
      }
    }
  } else if (type === "user") {
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && b.text) out.push({ kind: "user", text: clip(b.text, 600) });
      }
    } else if (typeof content === "string") {
      out.push({ kind: "user", text: clip(content, 600) });
    }
  }
  return out;
}

/**
 * Read new transcript events for a branch's agent from `offset` (a byte offset).
 * Only whole lines are consumed; the returned `offset` is the next read point.
 */
export async function readAgentLog(repoRoot: string, branch: string, offset = 0): Promise<LogChunk> {
  const wt = worktreePath(repoRoot, branch);
  const projectDir = path.join(os.homedir(), ".claude", "projects", encodeProjectDir(wt));
  const file = await newestTranscript(projectDir);
  if (!file) return { offset, events: [], found: false };

  let buf: Buffer;
  try {
    buf = await readFile(file);
  } catch {
    return { offset, events: [], found: true };
  }
  if (offset > buf.length) offset = 0; // file rotated / new session

  const slice = buf.subarray(offset).toString("utf8");
  const lastNl = slice.lastIndexOf("\n");
  if (lastNl < 0) return { offset, events: [], found: true };

  const consumable = slice.slice(0, lastNl + 1);
  const newOffset = offset + Buffer.byteLength(consumable, "utf8");

  const events: LogEvent[] = [];
  for (const line of consumable.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    for (const e of eventsFromLine(o)) events.push(e);
  }
  return { offset: newOffset, events, found: true };
}
