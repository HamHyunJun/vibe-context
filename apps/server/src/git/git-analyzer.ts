import { readFile, stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { simpleGit, type SimpleGit, type StatusResult } from 'simple-git';
import type { GitChangeType, GitCommitInfo, GitDelta, GitFileChange, Project } from '@vibe-context/shared';
import { VibeContextError } from '../utils/errors.js';
import { defaultTokenEstimator, type TokenEstimator } from '../utils/tokens.js';

/** Untracked files larger than this are not read; their size is estimated from bytes. */
const MAX_UNTRACKED_READ_BYTES = 1024 * 1024;
const MAX_DEPENDENTS = 30;
const MAX_AREAS = 10;
/** File names too generic to search for as an import path on their own. */
const GENERIC_BASENAMES = new Set(['index', 'main', 'app', 'types', 'utils', 'config', 'constants']);

export interface GitDeltaOptions {
  /** Search tracked files that reference the changed files. Default: true. */
  findDependents?: boolean;
  tokenEstimator?: TokenEstimator;
}

/**
 * Describes everything that changed since the last commit:
 * staged + unstaged changes against HEAD, plus untracked files.
 * Returns structured data instead of a raw diff.
 */
export async function analyzeGitDelta(project: Project, options: GitDeltaOptions = {}): Promise<GitDelta> {
  const tokenEstimator = options.tokenEstimator ?? defaultTokenEstimator;
  const git = simpleGit({ baseDir: project.rootPath });

  await assertGitRepository(git, project);

  try {
    const lastCommit = await readLastCommit(git);
    // On a branch without commits there is no HEAD; `git diff --cached` then compares against an empty tree.
    const diffBase = lastCommit ? ['HEAD'] : ['--cached'];

    // `-- .` limits everything to the project directory, so a project inside a monorepo
    // only sees its own changes. Paths in git output are always relative to the repository root.
    const scope = ['--', '.'];
    const [repoRoot, status, nameStatus, numstat, patch] = await Promise.all([
      git.revparse(['--show-toplevel']),
      git.status(['--untracked-files=all', ...scope]),
      git.raw(['diff', ...diffBase, '--name-status', '-z', '-M', ...scope]),
      git.raw(['diff', ...diffBase, '--numstat', '-z', '-M', ...scope]),
      git.raw(['diff', ...diffBase, '-M', ...scope]),
    ]);

    const lineCounts = parseNumstat(numstat);
    const stagedPaths = collectStagedPaths(status);
    const tracked = parseNameStatus(nameStatus).map<GitFileChange>((entry) => {
      const counts = lineCounts.get(entry.path) ?? { added: 0, deleted: 0, binary: false };
      return {
        path: entry.path,
        type: entry.type,
        ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
        linesAdded: counts.added,
        linesDeleted: counts.deleted,
        staged: stagedPaths.has(entry.path),
        binary: counts.binary,
      };
    });

    const trackedPaths = new Set(tracked.map((file) => file.path));
    const untrackedPaths = status.not_added.filter((path) => !trackedPaths.has(path));
    const untracked = await Promise.all(
      untrackedPaths.map((path) => readUntrackedFile(repoRoot.trim(), path, tokenEstimator)),
    );

    const allFiles = [...tracked, ...untracked.map((item) => item.change)];
    const files = {
      added: allFiles.filter((file) => file.type === 'added'),
      modified: allFiles.filter((file) => file.type === 'modified'),
      deleted: allFiles.filter((file) => file.type === 'deleted'),
      renamed: allFiles.filter((file) => file.type === 'renamed'),
    };

    const linesAdded = sum(allFiles.map((file) => file.linesAdded));
    const linesDeleted = sum(allFiles.map((file) => file.linesDeleted));
    const estimatedTokens =
      tokenEstimator.estimate(patch) + sum(untracked.map((item) => item.estimatedTokens));

    const areas = findAffectedAreas(allFiles);
    const dependents =
      options.findDependents === false ? [] : await findDependents(git, allFiles);

    return {
      projectId: project.id,
      branch: status.current ?? null,
      lastCommit,
      isClean: allFiles.length === 0,
      files,
      stats: {
        filesChanged: allFiles.length,
        linesAdded,
        linesDeleted,
        estimatedTokens,
      },
      summary: buildSummary(files, linesAdded, linesDeleted, areas, lastCommit),
      potentiallyAffected: { areas, dependents },
    };
  } catch (error) {
    if (error instanceof VibeContextError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new VibeContextError('GIT_FAILED', `git command failed in ${project.rootPath}: ${message}`);
  }
}

async function assertGitRepository(git: SimpleGit, project: Project): Promise<void> {
  let isRepo: boolean;
  try {
    isRepo = await git.checkIsRepo();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new VibeContextError('GIT_FAILED', `Could not run git. Is git installed and on PATH? (${message})`);
  }
  if (!isRepo) {
    throw new VibeContextError('NOT_A_GIT_REPOSITORY', `${project.rootPath} is not inside a git repository.`);
  }
}

async function readLastCommit(git: SimpleGit): Promise<GitCommitInfo | null> {
  try {
    await git.revparse(['--verify', 'HEAD']);
  } catch {
    return null; // no commits yet
  }
  const log = await git.log({ maxCount: 1 });
  const latest = log.latest;
  if (!latest) return null;
  return {
    hash: latest.hash,
    message: latest.message,
    author: latest.author_name,
    date: new Date(latest.date).toISOString(),
  };
}

interface NameStatusEntry {
  path: string;
  type: GitChangeType;
  previousPath?: string;
}

/**
 * Parses `git diff --name-status -z`.
 * Format: `M\0path\0`, `A\0path\0`, `D\0path\0`, `R087\0old\0new\0`, `C100\0src\0copy\0`.
 */
function parseNameStatus(output: string): NameStatusEntry[] {
  const parts = output.split('\0').filter((part) => part.length > 0);
  const entries: NameStatusEntry[] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i] ?? '';
    const letter = code.charAt(0);
    if (letter === 'R' || letter === 'C') {
      const from = parts[i + 1] ?? '';
      const to = parts[i + 2] ?? '';
      entries.push(
        letter === 'R' ? { path: to, type: 'renamed', previousPath: from } : { path: to, type: 'added' },
      );
      i += 3;
      continue;
    }
    const path = parts[i + 1] ?? '';
    const type: GitChangeType = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    entries.push({ path, type });
    i += 2;
  }
  return entries;
}

interface LineCount {
  added: number;
  deleted: number;
  binary: boolean;
}

/**
 * Parses `git diff --numstat -z`.
 * Normal:  `added\tdeleted\tpath\0`
 * Renamed: `added\tdeleted\t\0old\0new\0`
 * Binary files use `-` for both counts.
 */
function parseNumstat(output: string): Map<string, LineCount> {
  const result = new Map<string, LineCount>();
  const parts = output.split('\0');
  let i = 0;
  while (i < parts.length) {
    const record = parts[i] ?? '';
    if (record.length === 0) {
      i += 1;
      continue;
    }
    const [addedText = '0', deletedText = '0', pathText = ''] = record.split('\t');
    const binary = addedText === '-' || deletedText === '-';
    const count: LineCount = {
      added: binary ? 0 : Number.parseInt(addedText, 10) || 0,
      deleted: binary ? 0 : Number.parseInt(deletedText, 10) || 0,
      binary,
    };
    if (pathText.length > 0) {
      result.set(pathText, count);
      i += 1;
    } else {
      // rename: next two parts are old and new path
      const newPath = parts[i + 2] ?? '';
      result.set(newPath, count);
      i += 3;
    }
  }
  return result;
}

/** Paths with something staged in the index (first column of `git status --short`). */
function collectStagedPaths(status: StatusResult): Set<string> {
  return new Set(
    status.files.filter((file) => file.index !== ' ' && file.index !== '?').map((file) => file.path),
  );
}

async function readUntrackedFile(
  rootPath: string,
  path: string,
  tokenEstimator: TokenEstimator,
): Promise<{ change: GitFileChange; estimatedTokens: number }> {
  const absolutePath = join(rootPath, path);
  const base: GitFileChange = { path, type: 'added', linesAdded: 0, linesDeleted: 0, staged: false, binary: false };

  try {
    const { size } = await stat(absolutePath);
    if (size > MAX_UNTRACKED_READ_BYTES) {
      return { change: base, estimatedTokens: Math.ceil(size / 4) };
    }
    const buffer = await readFile(absolutePath);
    if (buffer.subarray(0, 8000).includes(0)) {
      return { change: { ...base, binary: true }, estimatedTokens: 0 };
    }
    const text = buffer.toString('utf8');
    const lines = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    return { change: { ...base, linesAdded: lines }, estimatedTokens: tokenEstimator.estimate(text) };
  } catch {
    // File disappeared between `git status` and reading it. Report it without size.
    return { change: base, estimatedTokens: 0 };
  }
}

/** Groups changed files by their top two directory levels, most changed first. */
function findAffectedAreas(files: GitFileChange[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const dir = posix.dirname(file.path);
    const area = dir === '.' ? '(root)' : `${dir.split('/').slice(0, 2).join('/')}/`;
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_AREAS)
    .map(([area]) => area);
}

/**
 * Turns a file path into the text an import statement would most likely contain.
 * `src/stores/recipe.ts` → `stores/recipe`, `components/recipe/index.ts` → `components/recipe`.
 */
function toImportNeedle(path: string): string | null {
  const withoutExt = path.replace(/\.[^./]+$/, '');
  const segments = withoutExt.split('/');
  const last = segments[segments.length - 1] ?? '';
  const meaningful = last === 'index' ? segments.slice(0, -1) : segments;
  const needle = meaningful.slice(-2).join('/');
  if (meaningful.length < 2 && (GENERIC_BASENAMES.has(needle) || needle.length < 4)) return null;
  return needle.length > 0 ? needle : null;
}

/**
 * Finds tracked files that mention a changed (non-added) file's path.
 * This is a cheap stand-in for a real dependency graph (planned for Phase 2+).
 * It does not see auto-imports (e.g. Nuxt components / composables).
 */
async function findDependents(git: SimpleGit, files: GitFileChange[]): Promise<string[]> {
  const sources = files.filter((file) => file.type !== 'added' && !file.binary);
  const needles = new Set<string>();
  for (const file of sources) {
    for (const path of [file.path, file.previousPath]) {
      if (!path) continue;
      const needle = toImportNeedle(path);
      if (needle) needles.add(needle);
    }
  }
  if (needles.size === 0) return [];

  // --full-name: print paths relative to the repository root, like the rest of the git output
  const args = ['grep', '-l', '-F', '-I', '--full-name'];
  for (const needle of needles) args.push('-e', needle);
  let output: string;
  try {
    output = await git.raw(args);
  } catch {
    return []; // git grep exits with 1 when nothing matches
  }

  const changed = new Set(files.map((file) => file.path));
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !changed.has(line))
    .slice(0, MAX_DEPENDENTS);
}

function buildSummary(
  files: GitDelta['files'],
  linesAdded: number,
  linesDeleted: number,
  areas: string[],
  lastCommit: GitCommitInfo | null,
): string {
  const total = files.added.length + files.modified.length + files.deleted.length + files.renamed.length;
  const since = lastCommit ? `since commit ${lastCommit.hash.slice(0, 7)} ("${firstLine(lastCommit.message)}")` : 'in a repository with no commits yet';
  if (total === 0) return `No changes ${since}.`;

  const parts = [
    files.added.length > 0 ? `${files.added.length} added` : '',
    files.modified.length > 0 ? `${files.modified.length} modified` : '',
    files.deleted.length > 0 ? `${files.deleted.length} deleted` : '',
    files.renamed.length > 0 ? `${files.renamed.length} renamed` : '',
  ].filter((part) => part.length > 0);

  const all = [...files.added, ...files.modified, ...files.deleted, ...files.renamed];
  const biggest = [...all].sort((a, b) => b.linesAdded + b.linesDeleted - (a.linesAdded + a.linesDeleted))[0];

  const sentences = [
    `${total} file${total === 1 ? '' : 's'} changed ${since} (+${linesAdded} / -${linesDeleted}): ${parts.join(', ')}.`,
  ];
  if (biggest && biggest.linesAdded + biggest.linesDeleted > 0) {
    sentences.push(`Largest change: ${biggest.path} (+${biggest.linesAdded} / -${biggest.linesDeleted}).`);
  }
  if (areas.length > 0) {
    sentences.push(`Changes are concentrated in ${areas.slice(0, 3).join(', ')}.`);
  }
  return sentences.join(' ');
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
