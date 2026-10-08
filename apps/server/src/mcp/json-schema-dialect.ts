import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Workaround for an MCP SDK (1.x) behavior.
 *
 * The SDK converts zod schemas to JSON Schema with `"$schema": "http://json-schema.org/draft-07/schema#"`.
 * The current MCP spec uses JSON Schema 2020-12 by default, and newer clients reject tools whose
 * schema declares draft-07 ("unsupported dialect"). The schemas we generate use no draft-07-only
 * keywords, so dropping the `$schema` line makes them valid 2020-12 schemas.
 *
 * Remove this once the SDK emits 2020-12 schemas.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stripDialect(schema: unknown): void {
  if (isRecord(schema)) delete schema.$schema;
}

function stripToolSchemas(message: JSONRPCMessage): JSONRPCMessage {
  if (!('result' in message) || !isRecord(message.result)) return message;
  const tools = message.result.tools;
  if (!Array.isArray(tools)) return message;
  for (const tool of tools) {
    if (!isRecord(tool)) continue;
    stripDialect(tool.inputSchema);
    stripDialect(tool.outputSchema);
  }
  return message;
}

/** Wraps a transport so that `tools/list` responses carry 2020-12 compatible schemas. */
export function withJsonSchema2020(transport: Transport): Transport {
  const send = transport.send.bind(transport);
  transport.send = (message, options) => send(stripToolSchemas(message), options);
  return transport;
}
