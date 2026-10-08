import type { AppDatabase } from '../db/client.js';
import type { MemorySearcher } from '../memory/memory-search.js';
import type { MemoryStore } from '../memory/memory-store.js';
import type { ProjectService } from '../project/project-service.js';

/** Services the MCP tools need. Created once in index.ts and passed to every tool. */
export interface ToolContext {
  db: AppDatabase;
  projects: ProjectService;
  memoryStore: MemoryStore;
  memorySearcher: MemorySearcher;
}
