import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execShell } from "./exec.js";
import { IntraFleetBus } from "./bus.js";
import type { ConflictResolver, ConflictFile } from "./resolver.js";
import type {
  ConflictResolution,
  Negotiator as NegotiatorInterface,
  SemanticConflictInput,
  TextualConflictInput,
} from "./integrator.js";

const CONFLICT_MARKER = /^(<{7}|={7}|>{7})/m;

export interface NegotiatorOptions {
  /** Parties to the negotiation. Rounds rotate through them so different agents
   *  take turns proposing — A proposes, tests fail, B counters, and so on. */
  resolvers: ConflictResolver[];
  /** Max rounds before escalating. Default 3. */
  maxRounds?: number;
  bus?: IntraFleetBus;
  testTimeoutMs?: number;
  logger?: (m: string) => void;
  /** Called when a conflict cannot be resolved within maxRounds. */
  onEscalate?: (info: { branch: string; kind: "textual" | "semantic"; detail: string }) => void;
}

/**
 * Drives bounded-round, test-verified conflict resolution. A resolution is only
 * accepted when the conflict markers are gone AND the test gate passes — chat
 * agreement alone never lands code. On non-convergence it escalates rather than
 * looping forever (the missing exit hatch behind "Main Agent makes final
 * judgement").
 */
export class Negotiator implements NegotiatorInterface {
  private readonly resolvers: ConflictResolver[];
  private readonly maxRounds: number;
  private readonly bus?: IntraFleetBus;
  private readonly testTimeoutMs?: number;
  private readonly log: (m: string) => void;
  private readonly onEscalate?: NegotiatorOptions["onEscalate"];

  constructor(opts: NegotiatorOptions) {
    if (opts.resolvers.length === 0) throw new Error("Negotiator needs at least one resolver");
    this.resolvers = opts.resolvers;
    this.maxRounds = Math.max(1, opts.maxRounds ?? 3);
    this.bus = opts.bus;
    this.testTimeoutMs = opts.testTimeoutMs;
    this.log = opts.logger ?? (() => {});
    this.onEscalate = opts.onEscalate;
  }

  async resolveTextual(input: TextualConflictInput): Promise<ConflictResolution> {
    const { worktreeGit, worktree, branch, conflictedFiles, testCommand } = input;
    let feedback: string | undefined;

    for (let round = 1; round <= this.maxRounds; round++) {
      const resolver = this.resolvers[(round - 1) % this.resolvers.length]!;
      const current = await this.readFiles(worktree, conflictedFiles);
      this.bus?.post({ from: resolver.name, kind: "propose", text: `round ${round}: resolving ${branch}` });

      const proposal = await resolver.propose({
        branch,
        worktree,
        kind: "textual",
        round,
        conflictedFiles: current,
        feedback,
      });
      await this.writeFiles(worktree, proposal.files);
      if (proposal.note) this.bus?.post({ from: resolver.name, kind: "note", text: proposal.note });

      const touched = unique([...conflictedFiles, ...proposal.files.map((f) => f.path)]);
      const remaining = await this.filesWithMarkers(worktree, touched);
      if (remaining.length > 0) {
        feedback = `unresolved conflict markers in: ${remaining.join(", ")}`;
        this.bus?.post({ from: "gate", kind: "feedback", text: feedback });
        continue;
      }

      const gate = await this.runGate(worktree, testCommand);
      if (!gate.ok) {
        feedback = gate.output;
        this.bus?.post({ from: "gate", kind: "feedback", text: `tests failed in round ${round}` });
        continue;
      }

      await worktreeGit.run(["add", "-A"]);
      await worktreeGit.run(["commit", "--no-edit"]);
      this.bus?.post({ from: resolver.name, kind: "resolved", text: `resolved ${branch} in round ${round}` });
      this.log(`✔ negotiated ${branch} in round ${round} (${resolver.name})`);
      return { resolved: true, detail: `resolved in round ${round} by ${resolver.name}` };
    }

    return this.escalate(branch, "textual");
  }

  async resolveSemantic(input: SemanticConflictInput): Promise<ConflictResolution> {
    const { worktreeGit, worktree, branch, testOutput, testCommand } = input;
    let feedback = testOutput;

    for (let round = 1; round <= this.maxRounds; round++) {
      const resolver = this.resolvers[(round - 1) % this.resolvers.length]!;
      this.bus?.post({ from: resolver.name, kind: "propose", text: `round ${round}: semantic fix for ${branch}` });

      const proposal = await resolver.propose({
        branch,
        worktree,
        kind: "semantic",
        round,
        conflictedFiles: [],
        feedback,
        testOutput,
      });
      await this.writeFiles(worktree, proposal.files);
      if (proposal.note) this.bus?.post({ from: resolver.name, kind: "note", text: proposal.note });

      const gate = await this.runGate(worktree, testCommand);
      if (!gate.ok) {
        feedback = gate.output;
        this.bus?.post({ from: "gate", kind: "feedback", text: `tests still failing in round ${round}` });
        continue;
      }

      await worktreeGit.run(["add", "-A"]);
      const status = await worktreeGit.run(["status", "--porcelain"]);
      if (status.trim()) await worktreeGit.run(["commit", "-m", `fix: integrate ${branch}`]);
      this.bus?.post({ from: resolver.name, kind: "resolved", text: `semantic fix for ${branch} in round ${round}` });
      this.log(`✔ semantic fix for ${branch} in round ${round} (${resolver.name})`);
      return { resolved: true, detail: `semantic fix in round ${round} by ${resolver.name}` };
    }

    return this.escalate(branch, "semantic");
  }

  private escalate(branch: string, kind: "textual" | "semantic"): ConflictResolution {
    const detail = `exhausted ${this.maxRounds} rounds without a green resolution`;
    this.bus?.post({ from: "negotiator", kind: "escalated", text: `escalating ${branch}: ${detail}` });
    this.log(`⚠ escalating ${branch} (${kind}): ${detail}`);
    this.onEscalate?.({ branch, kind, detail });
    return { resolved: false, escalated: true, detail };
  }

  private async runGate(worktree: string, testCommand?: string): Promise<{ ok: boolean; output: string }> {
    if (!testCommand) return { ok: true, output: "" };
    const t = await execShell(testCommand, worktree, { timeoutMs: this.testTimeoutMs });
    return { ok: t.code === 0, output: truncate(t.stdout + t.stderr) };
  }

  private async readFiles(worktree: string, files: string[]): Promise<ConflictFile[]> {
    const out: ConflictFile[] = [];
    for (const p of files) {
      try {
        out.push({ path: p, content: await readFile(path.join(worktree, p), "utf8") });
      } catch {
        out.push({ path: p, content: "" });
      }
    }
    return out;
  }

  private async writeFiles(worktree: string, files: ConflictFile[]): Promise<void> {
    for (const f of files) {
      await writeFile(path.join(worktree, f.path), f.content);
    }
  }

  private async filesWithMarkers(worktree: string, files: string[]): Promise<string[]> {
    const hits: string[] = [];
    for (const p of files) {
      try {
        const content = await readFile(path.join(worktree, p), "utf8");
        if (CONFLICT_MARKER.test(content)) hits.push(p);
      } catch {
        // missing file — nothing to flag
      }
    }
    return hits;
  }
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function truncate(s: string, max = 4000): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}
