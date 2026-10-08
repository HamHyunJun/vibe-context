import { randomUUID } from 'node:crypto';
import { desc, eq, inArray } from 'drizzle-orm';
import type { MemoryKind, SavedSession, SessionSummaryInput } from '@vibe-context/shared';
import type { AppDatabase } from '../db/client.js';
import { architectureRules, memories, sessions } from '../db/schema.js';

/** A session with all of its memories, as used by search and (later) the dashboard. */
export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  summary: string;
  changedFiles: string[];
  createdAt: Date;
  decisions: string[];
  problems: string[];
  solutions: string[];
  architectureRules: string[];
}

/** Trims, removes empty lines and duplicates while keeping the original order. */
function cleanList(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

export class MemoryStore {
  constructor(private readonly db: AppDatabase) {}

  /** Saves a session and its decisions, problems, solutions and architecture rules in one transaction. */
  saveSession(input: SessionSummaryInput): SavedSession {
    const sessionId = randomUUID();
    const createdAt = new Date();
    const items: { kind: MemoryKind; values: string[] }[] = [
      { kind: 'decision', values: cleanList(input.decisions) },
      { kind: 'problem', values: cleanList(input.problems) },
      { kind: 'solution', values: cleanList(input.solutions) },
    ];
    const rules = cleanList(input.architectureRules);

    const newRuleCount = this.db.transaction((tx) => {
      tx.insert(sessions)
        .values({
          id: sessionId,
          projectId: input.projectId,
          title: input.sessionTitle.trim(),
          summary: input.summary.trim(),
          changedFiles: cleanList(input.changedFiles),
          createdAt,
        })
        .run();

      const memoryRows = items.flatMap(({ kind, values }) =>
        values.map((content) => ({ id: randomUUID(), projectId: input.projectId, sessionId, kind, content, createdAt })),
      );
      if (memoryRows.length > 0) tx.insert(memories).values(memoryRows).run();

      if (rules.length === 0) return 0;
      // A rule that already exists for the project is skipped (unique index on project_id + rule).
      const inserted = tx
        .insert(architectureRules)
        .values(rules.map((rule) => ({ id: randomUUID(), projectId: input.projectId, sessionId, rule, createdAt })))
        .onConflictDoNothing()
        .returning({ id: architectureRules.id })
        .all();
      return inserted.length;
    });

    return {
      sessionId,
      projectId: input.projectId,
      sessionTitle: input.sessionTitle.trim(),
      createdAt: createdAt.toISOString(),
      savedCounts: {
        decisions: items[0]?.values.length ?? 0,
        problems: items[1]?.values.length ?? 0,
        solutions: items[2]?.values.length ?? 0,
        architectureRules: newRuleCount,
      },
    };
  }

  /** Loads sessions of a project (newest first) together with their memories and rules. */
  listSessionRecords(projectId: string, limit?: number): SessionRecord[] {
    const query = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.projectId, projectId))
      .orderBy(desc(sessions.createdAt));
    const sessionRows = limit === undefined ? query.all() : query.limit(limit).all();
    if (sessionRows.length === 0) return [];

    const sessionIds = sessionRows.map((row) => row.id);
    const memoryRows = this.db.select().from(memories).where(inArray(memories.sessionId, sessionIds)).all();
    const ruleRows = this.db
      .select()
      .from(architectureRules)
      .where(inArray(architectureRules.sessionId, sessionIds))
      .all();

    return sessionRows.map((row) => {
      const own = memoryRows.filter((memory) => memory.sessionId === row.id);
      const byKind = (kind: MemoryKind) => own.filter((memory) => memory.kind === kind).map((memory) => memory.content);
      return {
        id: row.id,
        projectId: row.projectId,
        title: row.title,
        summary: row.summary,
        changedFiles: row.changedFiles,
        createdAt: row.createdAt,
        decisions: byKind('decision'),
        problems: byKind('problem'),
        solutions: byKind('solution'),
        architectureRules: ruleRows.filter((rule) => rule.sessionId === row.id && rule.isActive).map((rule) => rule.rule),
      };
    });
  }
}
