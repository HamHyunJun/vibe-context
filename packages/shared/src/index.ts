/**
 * Domain types shared between the local server and the web dashboard.
 *
 * Rule: this package contains *types only*. Always import with `import type`
 * so nothing from here exists at runtime and no build step is needed.
 */

// ─── Project ────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

// ─── Git ────────────────────────────────────────────────────

export type GitChangeType = 'added' | 'modified' | 'deleted' | 'renamed';

export interface GitFileChange {
  path: string;
  type: GitChangeType;
  /** Only set for renamed files. */
  previousPath?: string;
  linesAdded: number;
  linesDeleted: number;
  /** Whether the change is staged (in the index). Untracked files are false. */
  staged: boolean;
  binary: boolean;
}

export interface GitCommitInfo {
  hash: string;
  message: string;
  author: string;
  date: string; // ISO 8601
}

export interface GitDeltaStats {
  filesChanged: number;
  linesAdded: number;
  linesDeleted: number;
  estimatedTokens: number;
}

export interface GitDelta {
  projectId: string;
  branch: string | null;
  /** null when the repository has no commits yet. */
  lastCommit: GitCommitInfo | null;
  isClean: boolean;
  files: {
    added: GitFileChange[];
    modified: GitFileChange[];
    deleted: GitFileChange[];
    renamed: GitFileChange[];
  };
  stats: GitDeltaStats;
  /** Rule-based, human readable summary of the change. */
  summary: string;
  potentiallyAffected: {
    /** Directories where the changes are concentrated, e.g. "stores/", "server/api/". */
    areas: string[];
    /** Tracked files that reference a changed file by path (heuristic text search, not a full import graph). */
    dependents: string[];
  };
}

// ─── Memory ─────────────────────────────────────────────────

export type MemoryKind = 'decision' | 'problem' | 'solution';

export interface SessionSummaryInput {
  projectId: string;
  sessionTitle: string;
  summary: string;
  decisions: string[];
  architectureRules: string[];
  changedFiles: string[];
  problems: string[];
  solutions: string[];
}

export interface SavedSession {
  sessionId: string;
  projectId: string;
  sessionTitle: string;
  createdAt: string;
  savedCounts: {
    decisions: number;
    problems: number;
    solutions: number;
    /** New rules only. Rules that already existed for the project are not duplicated. */
    architectureRules: number;
  };
}

export interface MemorySearchHit {
  sessionId: string;
  sessionTitle: string;
  summary: string;
  createdAt: string;
  /** 0 to 1. Higher is more relevant. */
  score: number;
  matchedTerms: string[];
  decisions: string[];
  architectureRules: string[];
  problems: string[];
  solutions: string[];
  changedFiles: string[];
}

export interface MemorySearchResult {
  projectId: string;
  query: string;
  /** Which search strategy produced the result, e.g. "keyword" (later "fts5", "embedding"). */
  strategy: string;
  hits: MemorySearchHit[];
}
