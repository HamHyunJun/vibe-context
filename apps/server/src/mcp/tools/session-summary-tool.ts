import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import { projectIdInput } from '../schemas.js';
import { runTool, toolSuccess } from '../tool-result.js';

const stringList = (description: string) => z.array(z.string()).default([]).describe(description);

export function registerSessionSummaryTool(server: McpServer, { projects, memoryStore }: ToolContext): void {
  server.registerTool(
    'save_session_summary',
    {
      title: 'Save session summary',
      description:
        'Save the key outcomes of the current coding session to the project memory so future sessions do not forget them. ' +
        'Call this when a task is finished. Write short, self-contained sentences: each decision, rule, problem and ' +
        'solution should make sense on its own when read months later.',
      inputSchema: z.object({
        projectId: projectIdInput,
        sessionTitle: z.string().min(1).describe('Short title of the work, e.g. "Recipe deletion implementation".'),
        summary: z.string().min(1).describe('What was done in this session, in 1 to 5 sentences.'),
        decisions: stringList('Decisions made and, if possible, why. e.g. "Use soft delete because recovery may be needed."'),
        architectureRules: stringList(
          'Project wide rules to always follow from now on. e.g. "API calls must not be made directly inside UI components."',
        ),
        changedFiles: stringList('Project relative paths of files changed in this session.'),
        problems: stringList('Problems or bugs encountered.'),
        solutions: stringList('How the problems were solved.'),
      }),
      outputSchema: z.object({
        sessionId: z.string(),
        projectId: z.string(),
        sessionTitle: z.string(),
        createdAt: z.string(),
        savedCounts: z.object({
          decisions: z.number().int(),
          problems: z.number().int(),
          solutions: z.number().int(),
          architectureRules: z.number().int(),
        }),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ projectId, ...input }) =>
      runTool(() => {
        const project = projects.resolve(projectId);
        const saved = memoryStore.saveSession({ projectId: project.id, ...input });
        projects.touch(project.id);

        const { savedCounts: counts } = saved;
        const skippedRules = input.architectureRules.length - counts.architectureRules;
        const text = [
          `Saved session "${saved.sessionTitle}" to project **${project.name}**.`,
          '',
          `- Decisions: ${counts.decisions}`,
          `- Architecture rules (new): ${counts.architectureRules}${skippedRules > 0 ? ` (${skippedRules} already existed or were empty)` : ''}`,
          `- Problems: ${counts.problems}`,
          `- Solutions: ${counts.solutions}`,
          `- Changed files: ${input.changedFiles.length}`,
          '',
          `Session id: ${saved.sessionId}`,
        ].join('\n');
        return toolSuccess(text, saved);
      }),
  );
}
