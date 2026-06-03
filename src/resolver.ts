export interface ConflictFile {
  path: string;
  /** Current on-disk content. For textual conflicts this still has merge markers. */
  content: string;
}

export interface ResolutionRequest {
  branch: string;
  /** Integration worktree path; the resolver may read additional files here. */
  worktree: string;
  kind: "textual" | "semantic";
  /** 1-based round number. */
  round: number;
  /** Conflicted files with their current content (empty for semantic conflicts). */
  conflictedFiles: ConflictFile[];
  /** Why the previous round was rejected (unresolved markers or test output). */
  feedback?: string;
  /** Failing test output, for semantic conflicts. */
  testOutput?: string;
}

export interface ResolutionProposal {
  /** Full replacement contents for the files this proposal touches. */
  files: ConflictFile[];
  /** Optional human-readable rationale, posted to the bus. */
  note?: string;
}

/** A party in a negotiation — proposes how to resolve a conflict. */
export interface ConflictResolver {
  readonly name: string;
  propose(req: ResolutionRequest): Promise<ResolutionProposal>;
}

/** A resolver backed by a plain function — for tests and embedded logic. */
export class ScriptConflictResolver implements ConflictResolver {
  constructor(
    public readonly name: string,
    private readonly fn: (req: ResolutionRequest) => Promise<ResolutionProposal> | ResolutionProposal,
  ) {}

  async propose(req: ResolutionRequest): Promise<ResolutionProposal> {
    return this.fn(req);
  }
}
