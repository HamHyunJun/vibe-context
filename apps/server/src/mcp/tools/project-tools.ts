import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import { projectSchema } from '../schemas.js';
import { runTool, toolSuccess } from '../tool-result.js';

/**
 * Project registration.
 * Not in the original Phase 1 tool list, but every other tool needs a registered project,
 * so registering from inside the AI client is the simplest way to get started.
 */
export function registerProjectTools(server: McpServer, { projects }: ToolContext): void {
  server.registerTool(
    'register_project',
    {
      title: 'Register project',
      description:
        'Register a local project directory with VibeContext so its git changes and session memories can be tracked. ' +
        'Call once per project. rootPath must be an absolute path to an existing directory.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Human readable name, e.g. "My Recipe App".'),
        rootPath: z.string().min(1).describe('Absolute path of the project root, e.g. /Users/me/dev/my-recipe-app'),
        id: z
          .string()
          .min(1)
          .optional()
          .describe('Optional short id (slug). Defaults to a slug of the name, e.g. "my-recipe-app".'),
      }),
      outputSchema: z.object({ project: projectSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ name, rootPath, id }) =>
      runTool(() => {
        const project = projects.register({ name, rootPath, id });
        const text = [
          `Registered project **${project.name}**`,
          '',
          `- id: \`${project.id}\``,
          `- rootPath: ${project.rootPath}`,
          '',
          `Use projectId "${project.id}" with the other VibeContext tools.`,
        ].join('\n');
        return toolSuccess(text, { project });
      }),
  );

  server.registerTool(
    'list_projects',
    {
      title: 'List projects',
      description: 'List all projects registered in VibeContext with their ids and root paths.',
      inputSchema: z.object({}),
      outputSchema: z.object({ projects: z.array(projectSchema) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      runTool(() => {
        const list = projects.list();
        const text =
          list.length === 0
            ? 'No projects registered yet. Use register_project to add one.'
            : ['Registered projects:', '', ...list.map((p) => `- \`${p.id}\` ${p.name} (${p.rootPath})`)].join('\n');
        return toolSuccess(text, { projects: list });
      }),
  );
}
