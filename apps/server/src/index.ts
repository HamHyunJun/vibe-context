#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDatabase } from './db/client.js';
import { createMcpServer } from './mcp/server.js';
import { KeywordMemorySearcher } from './memory/memory-search.js';
import { MemoryStore } from './memory/memory-store.js';
import { ProjectService } from './project/project-service.js';
import { loadConfig } from './utils/config.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { db, close } = openDatabase(config.databasePath, config.migrationsDir);

  // `node dist/index.js --migrate-only` applies migrations and exits (used by `pnpm db:migrate`).
  if (process.argv.includes('--migrate-only')) {
    close();
    logger.info('Migrations applied.');
    return;
  }

  const memoryStore = new MemoryStore(db);
  const server = createMcpServer({
    db,
    projects: new ProjectService(db),
    memoryStore,
    memorySearcher: new KeywordMemorySearcher(memoryStore),
  });

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down.`);
    await server.close();
    close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.connect(new StdioServerTransport());
  logger.info('MCP server running on stdio.');
}

main().catch((error: unknown) => {
  logger.error('Failed to start VibeContext server', error);
  process.exit(1);
});
