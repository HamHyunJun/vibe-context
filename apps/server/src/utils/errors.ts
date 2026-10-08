export type ErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_ALREADY_EXISTS'
  | 'INVALID_PATH'
  | 'NOT_A_GIT_REPOSITORY'
  | 'GIT_FAILED'
  | 'INVALID_INPUT';

/**
 * Expected errors that should be shown to the AI client as a readable message.
 * Anything that is not a VibeContextError is treated as an unexpected bug.
 */
export class VibeContextError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'VibeContextError';
    this.code = code;
  }
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof VibeContextError) return `[${error.code}] ${error.message}`;
  if (error instanceof Error) return `Unexpected error: ${error.message}`;
  return `Unexpected error: ${String(error)}`;
}
