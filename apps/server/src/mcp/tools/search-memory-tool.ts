import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemorySearchHit } from '@vibe-context/shared';
import { z } from 'zod';
import type { ToolContext } from '../context.js';
import { projectIdInput } from '../schemas.js';
import { runTool, toolSuccess } from '../tool-result.js';

const hitSchema = z.object({
  sessionId: z.string(),
  sessionTitle: z.string(),
  summary: z.string(),
  createdAt: z.string(),
  score: z.number().describe('Relevance from 0 to 1.'),
  matchedTerms: z.array(z.string()),
  decisions: z.array(z.string()),
  architectureRules: z.array(z.string()),
  problems: z.array(z.string()),
  solutions: z.array(z.string()),
  changedFiles: z.array(z.string()),
});

function formatHit(hit: MemorySearchHit, index: number): string {
  const lines = [`### ${index + 1}. ${hit.sessionTitle}`, `${hit.createdAt.slice(0, 10)} · score ${hit.score.toFixed(2)}`, '', hit.summary];
  const group = (title: string, items: string[]) => (items.length === 0 ? [] : ['', `${title}:`, ...items.map((item) => `- ${item}`)]);
  lines.push(
    ...group('Decisions', hit.decisions),
    ...group('Architecture rules', hit.architectureRules),
    ...group('Problems', hit.problems),
    ...group('Solutions', hit.solutions),
    ...group('Changed files', hit.changedFiles),
  );
  return lines.join('\n');
}

export function registerSearchMemoryTool(server: McpServer, { projects, memorySearcher }: ToolContext): void {
  server.registerTool(
    'search_past_memory',
    {
      title: 'Search past memory',
      description:
        'Search past session summaries, decisions, architecture rules, problems and solutions of the project by keywords. ' +
        'Use before changing an area of the code to recall earlier decisions. ' +
        'V1 is keyword based: include the important nouns (in the language the memories were written in), ' +
        'e.g. "recipe delete".',
      inputSchema: z.object({
        projectId: projectIdInput,
        query: z.string().min(1).describe('Keywords, e.g. "recipe delete".'),
        limit: z.number().int().min(1).max(50).default(5).describe('Maximum number of results. Default 5.'),
      }),
      outputSchema: z.object({
        projectId: z.string(),
        query: z.string(),
        strategy: z.string(),
        hits: z.array(hitSchema),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, query, limit }) =>
      runTool(() => {
        const project = projects.resolve(projectId);
        const result = memorySearcher.search({ projectId: project.id, query, limit });
        const text =
          result.hits.length === 0
            ? `No memories in **${project.name}** matched "${query}".`
            : [`## Relevant memories for "${query}"`, '', ...result.hits.map(formatHit).join('\n\n').split('\n')].join('\n');
        return toolSuccess(text, result);
      }),
  );
}
