import { randomUUID } from 'node:crypto';
import type { GitDelta } from '@vibe-context/shared';
import type { AppDatabase } from '../db/client.js';
import { gitSnapshots } from '../db/schema.js';

/** Stores the result of a `get_git_delta` call so the dashboard can show recent changes. */
export function recordGitSnapshot(db: AppDatabase, delta: GitDelta): void {
  db.insert(gitSnapshots)
    .values({
      id: randomUUID(),
      projectId: delta.projectId,
      branch: delta.branch,
      headCommit: delta.lastCommit?.hash ?? null,
      filesChanged: delta.stats.filesChanged,
      linesAdded: delta.stats.linesAdded,
      linesDeleted: delta.stats.linesDeleted,
      estimatedTokens: delta.stats.estimatedTokens,
      summary: delta.summary,
      delta,
    })
    .run();
}
