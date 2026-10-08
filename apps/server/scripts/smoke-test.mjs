// End-to-end check of the built MCP server.
//
// 1. Creates a throwaway git repo with committed + changed files
// 2. Starts dist/index.js over stdio with a throwaway SQLite DB (real data is not touched)
// 3. Calls every tool like an MCP client would and prints the results
//
// Usage: pnpm build && pnpm smoke
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const workDir = mkdtempSync(join(tmpdir(), 'vibe-context-smoke-'));
const repo = join(workDir, 'recipe-app');

function git(...args) {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}
function write(path, content) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
}

// ── 1. sample repository ──────────────────────────────────
mkdirSync(repo);
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'smoke@example.com');
git('config', 'user.name', 'Smoke Test');
write('stores/recipe.ts', 'export const useRecipeStore = () => {\n  return { recipes: [] };\n};\n');
write('components/RecipeCard.vue', '<script setup lang="ts">\nimport { useRecipeStore } from "../stores/recipe";\n</script>\n');
write('pages/recipes/[id].vue', '<script setup lang="ts">\nimport { useRecipeStore } from "~/stores/recipe";\n</script>\n');
write('composables/useOldRecipe.ts', 'export function useOldRecipe() {}\n');
write('utils/format.ts', 'export const format = (v: string) => v;\n');
git('add', '.');
git('commit', '-q', '-m', 'feat: initial recipe app');

write('stores/recipe.ts', 'export const useRecipeStore = () => {\n  const remove = (id: string) => {};\n  return { recipes: [], remove };\n};\n');
write('server/api/recipes/[id].delete.ts', 'export default defineEventHandler(() => ({ ok: true }));\n');
git('rm', '-q', 'composables/useOldRecipe.ts');
git('mv', 'utils/format.ts', 'utils/formatters.ts');

// ── 2. start server ───────────────────────────────────────
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: repo, // like Claude Code: the server runs inside the project
  env: { ...process.env, VIBE_CONTEXT_DB_PATH: join(workDir, 'smoke.db'), VIBE_CONTEXT_LOG_LEVEL: 'warn' },
  stderr: 'inherit',
});
const client = new Client({ name: 'vibe-context-smoke-test', version: '0.0.0' });

let failed = false;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
  console.log(`\n━━━━ ${name} ${JSON.stringify(args)} ━━━━\n${text}`);
  if (result.isError) {
    failed = true;
    console.error(`✗ ${name} returned an error`);
  } else if (!result.structuredContent) {
    failed = true;
    console.error(`✗ ${name} returned no structuredContent`);
  }
  return result;
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log('Tools:', tools.map((tool) => tool.name).join(', '));
  // Newer MCP clients validate with JSON Schema 2020-12 and reject a draft-07 "$schema" declaration.
  const draft07 = tools.filter((tool) => tool.inputSchema.$schema || tool.outputSchema?.$schema);
  if (draft07.length > 0) {
    failed = true;
    console.error(`✗ tools declare a $schema dialect: ${draft07.map((tool) => tool.name).join(', ')}`);
  } else {
    console.log('✓ tool schemas have no draft-07 $schema (2020-12 compatible)');
  }

  await call('register_project', { name: 'My Recipe App', rootPath: repo });
  await call('list_projects', {});
  const delta = await call('get_git_delta', { projectId: 'my-recipe-app' });
  await call('save_session_summary', {
    projectId: 'my-recipe-app',
    sessionTitle: 'Recipe deletion implementation',
    summary: 'Recipe deletion functionality was implemented.',
    decisions: ['Use soft delete because future recovery functionality may be required.', 'Delete API is handled through composable'],
    architectureRules: ['API calls should not be made directly inside UI components', 'Server state should remain separate from client state'],
    changedFiles: ['stores/recipe.ts', 'server/api/recipes/[id].delete.ts'],
    problems: ['Deleted recipes still appeared in the list'],
    solutions: ['Filter out recipes with deletedAt in the store getter'],
  });
  await call('save_session_summary', {
    // no projectId: resolved from the server's working directory
    sessionTitle: 'Recipe API architecture',
    summary: 'API calls are handled through composables.',
    decisions: ['All recipe API calls go through useRecipeApi composable'],
    architectureRules: ['API calls should not be made directly inside UI components'], // duplicate → skipped
  });
  await call('save_session_summary', {
    sessionTitle: 'User profile page',
    summary: 'Added the user profile page with avatar upload.',
  });
  await call('save_session_summary', {
    sessionTitle: '레시피 삭제 버그 수정',
    summary: '삭제한 레시피가 목록에 남아 있던 문제를 수정했다.',
    decisions: ['목록 조회 시 deletedAt이 있는 레시피는 제외한다'],
  });
  const search = await call('search_past_memory', { projectId: 'my-recipe-app', query: 'recipe delete' });
  const koreanSearch = await call('search_past_memory', { query: '레시피를 삭제' });

  // Sanity checks on the structured output
  const stats = delta.structuredContent?.stats;
  const files = delta.structuredContent?.files;
  const checks = [
    ['git delta sees 4 changed files (1 added, 1 modified, 1 deleted, 1 renamed)', stats?.filesChanged === 4],
    ['git delta finds rename', files?.renamed?.[0]?.previousPath === 'utils/format.ts'],
    ['git delta finds dependents', delta.structuredContent?.potentiallyAffected?.dependents?.length === 2],
    ['search ranks deletion session first', search.structuredContent?.hits?.[0]?.sessionTitle === 'Recipe deletion implementation'],
    ['korean search strips particles ("레시피를" → "레시피")', koreanSearch.structuredContent?.hits?.[0]?.sessionTitle === '레시피 삭제 버그 수정'],
    ['search excludes unrelated session', search.structuredContent?.hits?.every((hit) => hit.sessionTitle !== 'User profile page')],
  ];
  console.log('\n━━━━ checks ━━━━');
  for (const [label, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${label}`);
    if (!ok) failed = true;
  }

  // Error path: unknown project must be a readable tool error, not a crash
  const missing = await client.callTool({ name: 'get_git_delta', arguments: { projectId: 'nope' } });
  console.log(`${missing.isError ? '✓' : '✗'} unknown project returns a tool error`);
  if (!missing.isError) failed = true;
} finally {
  await client.close();
  rmSync(workDir, { recursive: true, force: true });
}

console.log(failed ? '\nSmoke test FAILED' : '\nSmoke test passed');
process.exit(failed ? 1 : 0);
