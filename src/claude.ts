import { spawn } from "node:child_process";

export interface RunClaudeOptions {
  cwd: string;
  prompt: string;
  bin?: string;
  /** CLI args. Default ["-p", "--permission-mode", "acceptEdits"]. */
  args?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Spawn through a shell (if bin is an alias/builtin). Default false. */
  shell?: boolean;
}

export interface RunClaudeResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function defaultClaudeBin(): string {
  return process.platform === "win32" ? "claude.cmd" : "claude";
}

/**
 * Run a headless Claude Code agent in a directory, feeding the prompt on stdin
 * (so task/conflict text needs no shell-escaping). Resolves with the exit code
 * and captured output; never rejects.
 */
export function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const bin = opts.bin ?? defaultClaudeBin();
  const args = opts.args ?? ["-p", "--permission-mode", "acceptEdits"];
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      shell: opts.shell ?? false,
      env: { ...process.env, ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += "\n[harness] agent timed out";
    }, opts.timeoutMs ?? 30 * 60 * 1000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({ code: 127, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? 0, stdout, stderr });
    });

    child.stdin.write(opts.prompt);
    child.stdin.end();
  });
}
