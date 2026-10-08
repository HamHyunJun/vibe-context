import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../utils/logger.js';
import { VibeContextError, toErrorMessage } from '../utils/errors.js';

/**
 * Every tool returns both:
 * - `content`: Markdown text, readable by any MCP client and by the model
 * - `structuredContent`: JSON matching the tool's `outputSchema`, for clients/programs that parse results
 */
export function toolSuccess(markdown: string, structured: object): CallToolResult {
  return {
    content: [{ type: 'text', text: markdown }],
    structuredContent: { ...structured },
  };
}

export function toolError(error: unknown): CallToolResult {
  if (!(error instanceof VibeContextError)) logger.error('Unexpected tool error', error);
  return {
    content: [{ type: 'text', text: toErrorMessage(error) }],
    isError: true,
  };
}

/** Runs a tool body and converts thrown errors into an MCP error result. */
export async function runTool(body: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    return toolError(error);
  }
}

export function bulletList(items: string[], empty = '- (none)'): string {
  return items.length === 0 ? empty : items.map((item) => `- ${item}`).join('\n');
}

export function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}
