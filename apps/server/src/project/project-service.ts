import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import type { Project } from '@vibe-context/shared';
import type { AppDatabase } from '../db/client.js';
import { projects, type ProjectRow } from '../db/schema.js';
import { VibeContextError } from '../utils/errors.js';

export interface RegisterProjectInput {
  name: string;
  rootPath: string;
  /** Optional custom id. Defaults to a slug of the name. */
  id?: string | undefined;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** "My Recipe App" → "my-recipe-app". Non-latin names fall back to a short random id. */
function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug.length > 0 ? slug : `project-${randomUUID().slice(0, 8)}`;
}

/** Resolves symlinks and checks that the path is an existing directory. */
function normalizeRootPath(rootPath: string): string {
  if (!isAbsolute(rootPath)) {
    throw new VibeContextError('INVALID_PATH', `rootPath must be an absolute path: ${rootPath}`);
  }
  let realPath: string;
  try {
    realPath = realpathSync(resolve(rootPath));
  } catch {
    throw new VibeContextError('INVALID_PATH', `Directory does not exist: ${rootPath}`);
  }
  if (!statSync(realPath).isDirectory()) {
    throw new VibeContextError('INVALID_PATH', `Not a directory: ${rootPath}`);
  }
  return realPath;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class ProjectService {
  constructor(private readonly db: AppDatabase) {}

  register(input: RegisterProjectInput): Project {
    const name = input.name.trim();
    if (!name) throw new VibeContextError('INVALID_INPUT', 'Project name is required.');

    const rootPath = normalizeRootPath(input.rootPath);
    const existingByPath = this.db.select().from(projects).where(eq(projects.rootPath, rootPath)).get();
    if (existingByPath) {
      throw new VibeContextError(
        'PROJECT_ALREADY_EXISTS',
        `This directory is already registered as "${existingByPath.name}" (id: ${existingByPath.id}).`,
      );
    }

    const id = input.id ? slugify(input.id) : this.uniqueId(slugify(name));
    if (this.findById(id)) {
      throw new VibeContextError('PROJECT_ALREADY_EXISTS', `Project id "${id}" is already used.`);
    }

    const row = this.db.insert(projects).values({ id, name, rootPath }).returning().get();
    return toProject(row);
  }

  list(): Project[] {
    return this.db.select().from(projects).orderBy(asc(projects.name)).all().map(toProject);
  }

  findById(id: string): Project | undefined {
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get();
    return row ? toProject(row) : undefined;
  }

  /**
   * Finds the project a tool call is about.
   * - With `projectId`: that project.
   * - Without: the registered project that contains `cwd`. Claude Code starts MCP
   *   servers inside the project directory, so this usually just works there.
   */
  resolve(projectId: string | undefined, cwd: string = process.cwd()): Project {
    if (projectId) {
      const project = this.findById(projectId);
      if (!project) {
        throw new VibeContextError('PROJECT_NOT_FOUND', `${this.notFoundMessage(`No project with id "${projectId}".`)}`);
      }
      return project;
    }

    let realCwd: string;
    try {
      realCwd = realpathSync(cwd);
    } catch {
      realCwd = cwd;
    }
    const match = this.list()
      .filter((project) => isInside(project.rootPath, realCwd))
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
    if (!match) {
      throw new VibeContextError(
        'PROJECT_NOT_FOUND',
        this.notFoundMessage(`projectId was not given and the current directory (${cwd}) is not inside a registered project.`),
      );
    }
    return match;
  }

  /** Marks the project as recently used. */
  touch(projectId: string): void {
    this.db.update(projects).set({ updatedAt: new Date() }).where(eq(projects.id, projectId)).run();
  }

  private uniqueId(base: string): string {
    let candidate = base;
    let suffix = 2;
    while (this.findById(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  private notFoundMessage(reason: string): string {
    const registered = this.list();
    if (registered.length === 0) {
      return `${reason} No projects are registered yet. Call register_project first.`;
    }
    const ids = registered.map((project) => `${project.id} (${project.rootPath})`).join(', ');
    return `${reason} Registered projects: ${ids}`;
  }
}
