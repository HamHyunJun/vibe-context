import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * SQLite schema (Drizzle ORM).
 *
 * After changing this file run `pnpm db:generate` to create a new SQL migration.
 * Migrations are applied automatically when the server starts.
 *
 * Conventions:
 * - Primary keys are text ids (slug for projects, UUID for everything else).
 * - Timestamps are stored as Unix milliseconds (`timestamp_ms` → JS Date).
 * - Lists are stored as JSON text columns.
 */

const createdAt = () =>
  integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .default(sql`(unixepoch() * 1000)`);

/** A local project directory registered in VibeContext. */
export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    rootPath: text('root_path').notNull(),
    createdAt: createdAt(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (table) => [uniqueIndex('projects_root_path_unique').on(table.rootPath)],
);

/** One AI coding session, saved by `save_session_summary`. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    changedFiles: text('changed_files', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    createdAt: createdAt(),
  },
  (table) => [index('sessions_project_created_idx').on(table.projectId, table.createdAt)],
);

/**
 * Individual pieces of knowledge extracted from a session.
 * Kept as separate rows so they can be searched, listed and (later) embedded one by one.
 */
export const memories = sqliteTable(
  'memories',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['decision', 'problem', 'solution'] }).notNull(),
    content: text('content').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('memories_project_kind_idx').on(table.projectId, table.kind),
    index('memories_session_idx').on(table.sessionId),
  ],
);

/** Project wide rules the AI should always follow. One row per unique rule per project. */
export const architectureRules = sqliteTable(
  'architecture_rules',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The session that first introduced the rule. Null when added manually. */
    sessionId: text('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    rule: text('rule').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('architecture_rules_project_rule_unique').on(table.projectId, table.rule)],
);

/** A record of each `get_git_delta` call. Used later by the dashboard and Context Analytics. */
export const gitSnapshots = sqliteTable(
  'git_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    branch: text('branch'),
    headCommit: text('head_commit'),
    filesChanged: integer('files_changed').notNull(),
    linesAdded: integer('lines_added').notNull(),
    linesDeleted: integer('lines_deleted').notNull(),
    estimatedTokens: integer('estimated_tokens').notNull(),
    summary: text('summary').notNull(),
    /** Full structured GitDelta as JSON, so the dashboard can render it without re-running git. */
    delta: text('delta', { mode: 'json' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('git_snapshots_project_created_idx').on(table.projectId, table.createdAt)],
);

export type ProjectRow = typeof projects.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type MemoryRow = typeof memories.$inferSelect;
export type ArchitectureRuleRow = typeof architectureRules.$inferSelect;
export type GitSnapshotRow = typeof gitSnapshots.$inferSelect;
