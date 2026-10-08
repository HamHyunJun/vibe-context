import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { APP_NAME, APP_VERSION } from '../utils/config.js';
import type { ToolContext } from './context.js';
import { registerGitDeltaTool } from './tools/git-delta-tool.js';
import { registerProjectTools } from './tools/project-tools.js';
import { registerSearchMemoryTool } from './tools/search-memory-tool.js';
import { registerSessionSummaryTool } from './tools/session-summary-tool.js';

/**
 * Builds the MCP server with all tools registered.
 * Transport independent: index.ts connects it to stdio, and a future
 * HTTP transport (for the dashboard or remote clients) can reuse this as is.
 */
export function createMcpServer(context: ToolContext): McpServer {
  const server = new McpServer(
    { name: APP_NAME, version: APP_VERSION },
    {
      instructions:
        'VibeContext keeps project memory and git context for AI coding. ' +
        'At the start of a task call get_git_delta and search_past_memory instead of reading many files. ' +
        'When a task is finished call save_session_summary with the decisions and architecture rules. ' +
        'If no project is registered yet, call register_project with the absolute project path.',
    },
  );

  registerProjectTools(server, context);
  registerGitDeltaTool(server, context);
  registerSessionSummaryTool(server, context);
  registerSearchMemoryTool(server, context);

  return server;
}
