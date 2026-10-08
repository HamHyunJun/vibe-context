import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GitDelta, GitFileChange } from '@vibe-context/shared';
import { z } from 'zod';
import { analyzeGitDelta } from '../../git/git-analyzer.js';
import { recordGitSnapshot } from '../../git/git-snapshots.js';
import type { ToolContext } from '../context.js';
import { projectIdInput } from '../schemas.js';
import { bulletList, formatNumber, runTool, toolSuccess } from '../tool-result.js';

const fileChangeSchema = z.object({
  path: z.string(),
  type: z.enum(['added', 'modified', 'deleted', 'renamed']),
  previousPath: z.string().optional(),
  linesAdded: z.number().int(),
  linesDeleted: z.number().int(),
  staged: z.boolean(),
  binary: z.boolean(),
});

const gitDeltaOutputSchema = z.object({
  projectId: z.string(),
  branch: z.string().nullable(),
  lastCommit: z
    .object({ hash: z.string(), message: z.string(), author: z.string(), date: z.string() })
    .nullable(),
  isClean: z.boolean(),
  files: z.object({
    added: z.array(fileChangeSchema),
    modified: z.array(fileChangeSchema),
    deleted: z.array(fileChangeSchema),
    renamed: z.array(fileChangeSchema),
  }),
  stats: z.object({
    filesChanged: z.number().int(),
    linesAdded: z.number().int(),
    linesDeleted: z.number().int(),
    estimatedTokens: z.number().int(),
  }),
  summary: z.string(),
  potentiallyAffected: z.object({
    areas: z.array(z.string()),
    dependents: z.array(z.string()),
  }),
});

// Compile-time check: the shared GitDelta type must match the published output schema.
type GitDeltaOutput = z.infer<typeof gitDeltaOutputSchema>;
const assertGitDeltaMatchesSchema = (delta: GitDelta): GitDeltaOutput => delta;
void assertGitDeltaMatchesSchema;

function describeFile(file: GitFileChange): string {
  const counts = file.binary ? 'binary' : `+${file.linesAdded} / -${file.linesDeleted}`;
  const from = file.previousPath ? ` (from ${file.previousPath})` : '';
  return `${file.path}${from} [${counts}]`;
}

function toMarkdown(delta: GitDelta, projectName: string): string {
  const { files, stats } = delta;
  const section = (title: string, list: GitFileChange[]) =>
    list.length === 0 ? [] : [`### ${title}`, bulletList(list.map(describeFile)), ''];
  const commit = delta.lastCommit
    ? `${delta.lastCommit.hash.slice(0, 7)} "${delta.lastCommit.message.split('\n')[0] ?? ''}" (${delta.lastCommit.date})`
    : '(no commits yet)';

  return [
    `## Git Delta: ${projectName}`,
    '',
    `Branch: ${delta.branch ?? '(detached)'}`,
    `Last commit: ${commit}`,
    '',
    ...(delta.isClean
      ? ['Working tree is clean. Nothing changed since the last commit.', '']
      : [
          ...section('Added', files.added),
          ...section('Modified', files.modified),
          ...section('Deleted', files.deleted),
          ...section('Renamed', files.renamed),
        ]),
    '### Summary',
    delta.summary,
    '',
    '### Potentially affected',
    'Areas:',
    bulletList(delta.potentiallyAffected.areas),
    'Files referencing changed files (text search, may be incomplete):',
    bulletList(delta.potentiallyAffected.dependents),
    '',
    '### Size',
    `Files changed: ${formatNumber(stats.filesChanged)}`,
    `Lines added: ${formatNumber(stats.linesAdded)}`,
    `Lines deleted: ${formatNumber(stats.linesDeleted)}`,
    `Estimated context size of the full diff: ${formatNumber(stats.estimatedTokens)} tokens`,
  ].join('\n');
}

export function registerGitDeltaTool(server: McpServer, { db, projects }: ToolContext): void {
  server.registerTool(
    'get_git_delta',
    {
      title: 'Get git delta',
      description:
        'Summarize what changed in the project since the last commit (staged, unstaged and untracked files) ' +
        'without returning the raw diff: added/modified/deleted/renamed files, line counts, a summary, ' +
        'potentially affected areas and the estimated token size of the full diff. ' +
        'Use this at the start of a task instead of reading the whole diff.',
      inputSchema: z.object({
        projectId: projectIdInput,
        findDependents: z
          .boolean()
          .optional()
          .describe('Search tracked files that reference the changed files. Default true. Set false for very large repos.'),
      }),
      outputSchema: gitDeltaOutputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ projectId, findDependents }) =>
      runTool(async () => {
        const project = projects.resolve(projectId);
        const delta = await analyzeGitDelta(project, { findDependents: findDependents ?? true });
        recordGitSnapshot(db, delta);
        projects.touch(project.id);
        return toolSuccess(toMarkdown(delta, project.name), delta);
      }),
  );
}
