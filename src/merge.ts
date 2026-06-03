import { Git } from "./git.js";

export interface ConflictReport {
  clean: boolean;
  /** Files with textual conflicts (empty when clean). */
  conflictedFiles: string[];
  /** The merged tree oid produced by merge-tree (present even with conflicts). */
  tree?: string;
  /** Raw merge-tree informational output, for diagnostics. */
  raw: string;
}

/**
 * Conflict detection + real merges. Detection uses `git merge-tree --write-tree`,
 * which computes the merge result *without* touching a working tree or index —
 * cheap enough to run continuously to predict trouble before it lands.
 *
 * Note: merge-tree finds only TEXTUAL conflicts. Semantic conflicts (a clean
 * merge that nonetheless breaks the build/tests) are caught downstream by the
 * test-gate, not here.
 */
export class MergeTool {
  constructor(private readonly git: Git) {}

  /**
   * Trial-merge `branchB` into `branchA` and report conflicts. Requires git
   * >= 2.38 (`merge-tree --write-tree`). Exit code 0 => clean, 1 => conflicts.
   */
  async detectConflicts(branchA: string, branchB: string): Promise<ConflictReport> {
    const r = await this.git.tryRun([
      "merge-tree",
      "--write-tree",
      "--name-only",
      branchA,
      branchB,
    ]);
    const lines = r.stdout.split("\n");
    const tree = lines[0]?.trim() || undefined;

    if (r.code === 0) {
      return { clean: true, conflictedFiles: [], tree, raw: r.stdout };
    }

    // On conflict, output is: <oid>\n<conflicted file list>\n\n<informational msgs>
    const conflictedFiles: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === "") break;
      conflictedFiles.push(line.trim());
    }
    return { clean: false, conflictedFiles, tree, raw: r.stdout + r.stderr };
  }

  /**
   * Perform a real merge of `branch` into the currently checked-out branch of
   * `worktreeGit`. Returns whether it merged cleanly; on conflict the working
   * tree is left with conflict markers (caller decides whether to abort).
   */
  async mergeInto(
    worktreeGit: Git,
    branch: string,
    message: string,
  ): Promise<{ merged: boolean; conflictedFiles: string[] }> {
    const r = await worktreeGit.tryRun(["merge", "--no-ff", "-m", message, branch]);
    if (r.code === 0) return { merged: true, conflictedFiles: [] };
    const status = await worktreeGit.run(["diff", "--name-only", "--diff-filter=U"]);
    const conflictedFiles = status.split("\n").map((s) => s.trim()).filter(Boolean);
    return { merged: false, conflictedFiles };
  }

  /** Abort an in-progress merge in a worktree. */
  async abortMerge(worktreeGit: Git): Promise<void> {
    await worktreeGit.tryRun(["merge", "--abort"]);
  }
}
