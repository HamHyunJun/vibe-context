import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { logger } from '../utils/logger.js';
import * as schema from './schema.js';

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  close: () => void;
}

/** Opens the SQLite file, enables safe defaults and applies pending migrations. */
export function openDatabase(databasePath: string, migrationsDir: string): DatabaseHandle {
  const sqlite = new Database(databasePath);
  sqlite.pragma('journal_mode = WAL'); // dashboard and MCP server can read/write at the same time
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: migrationsDir });
  logger.info(`Database ready: ${databasePath}`);

  return {
    db,
    close: () => sqlite.close(),
  };
}
