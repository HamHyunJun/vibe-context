import { defineConfig } from 'drizzle-kit';
import { resolveDatabasePath } from './src/utils/config.js';

// drizzle-kit only needs the DB path for `db:studio`.
// `db:generate` reads the schema and writes SQL files into ./drizzle.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: resolveDatabasePath(),
  },
  strict: true,
  verbose: true,
});
