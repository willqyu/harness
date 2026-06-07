import { readFile } from "node:fs/promises";
import path from "node:path";
import { Registry, type RegistryEntry } from "./registry.js";
import { WorktreeManager, type WorktreeInfo } from "./worktree.js";
import { CheckpointManager, type Checkpoint } from "./checkpoint.js";
import { InboxManager } from "./inbox.js";
import { latestActivityAt } from "./transcript.js";
import { Git } from "./git.js";
import type { IntegrationResult } from "./integrator.js";

export interface IntegrationState extends IntegrationResult {
  updatedAt: string;
}

/** A worker record plus its last activity and whether its branch is in main. */
export type WorkerStatus = RegistryEntry & { lastActivityAt?: string; merged?: boolean };

export interface FleetStatus {
  repoRoot: string;
  generatedAt: string;
  /** Per-branch worker records (pending/running/completed/failed). */
  workers: WorkerStatus[];
  /** Live git worktrees (including main). */
  worktrees: WorktreeInfo[];
  /** Durable worker checkpoints. */
  checkpoints: Checkpoint[];
  /** Latest integration result, if any. */
  integration: IntegrationState | null;
  /** Per-branch interaction state (paused + queued message count). */
  inbox: Record<string, { paused: boolean; count: number }>;
  /** Primary working tree (repo root): current branch + uncommitted-change count. */
  repo: { branch: string; dirty: boolean; changes: number };
}

export interface FleetStatusPaths {
  registryFile?: string;
  worktreeDir?: string;
  checkpointDir?: string;
  integrationFile?: string;
}

/**
 * Aggregates everything the orchestrator persisted under .harness into a single
 * snapshot — the read model behind both `harness status` and the web UI.
 */
export async function readFleetStatus(repoRoot: string, paths: FleetStatusPaths = {}): Promise<FleetStatus> {
  const dir = path.join(repoRoot, ".harness");
  const registry = await Registry.open(paths.registryFile ?? path.join(dir, "registry.json"));
  const wtm = new WorktreeManager(repoRoot, paths.worktreeDir ?? path.join(dir, "worktrees"));
  const cpm = new CheckpointManager(paths.checkpointDir ?? path.join(dir, "checkpoints"));

  let integration: IntegrationState | null = null;
  try {
    integration = JSON.parse(
      await readFile(paths.integrationFile ?? path.join(dir, "integration.json"), "utf8"),
    ) as IntegrationState;
  } catch {
    integration = null;
  }

  const inboxes = new InboxManager(repoRoot);
  const git = new Git(repoRoot);
  const mainRef = (await git.tryRun(["rev-parse", "--verify", "--quiet", "main"])).code === 0 ? "main" : "HEAD";
  const inbox: Record<string, { paused: boolean; count: number }> = {};
  const workers: WorkerStatus[] = [];
  for (const w of registry.all()) {
    const s = await inboxes.state(w.branch);
    if (s.count > 0) inbox[w.branch] = s;
    // Only running agents are still emitting transcript; skip the stat otherwise.
    const lastActivityAt = w.state === "running" ? await latestActivityAt(repoRoot, w.branch) : null;
    // Whether this branch has already landed in main (Extend is then disabled).
    const merged = w.head
      ? (await git.tryRun(["merge-base", "--is-ancestor", w.head, mainRef])).code === 0
      : false;
    workers.push({ ...w, ...(lastActivityAt ? { lastActivityAt } : {}), merged });
  }

  // Primary working tree state — drives the per-worker checkout button.
  const currentBranch = (await git.tryRun(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || "HEAD";
  const porcelain = (await git.tryRun(["status", "--porcelain"])).stdout;
  const changes = porcelain.split("\n").filter((l) => l.trim()).length;

  return {
    repoRoot,
    generatedAt: new Date().toISOString(),
    workers,
    worktrees: await wtm.list().catch(() => []),
    checkpoints: await cpm.list(),
    integration,
    inbox,
    repo: { branch: currentBranch, dirty: changes > 0, changes },
  };
}
