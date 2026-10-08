import { z } from 'zod';

/** Shared zod pieces used by several tools. */

export const projectIdInput = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Registered project id (see list_projects). If omitted, the registered project that contains the ' +
      "server's current working directory is used, which works automatically in Claude Code.",
  );

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  rootPath: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
