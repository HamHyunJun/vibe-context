/**
 * MCP over stdio uses stdout for protocol messages.
 * Anything written to stdout that is not JSON-RPC breaks the client,
 * so all logging goes to stderr.
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const value = process.env.VIBE_CONTEXT_LOG_LEVEL;
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' ? value : 'info';
}

function write(level: Level, message: string, detail?: unknown): void {
  if (order[level] < order[currentLevel()]) return;
  const line = `[vibe-context] ${new Date().toISOString()} ${level.toUpperCase()} ${message}`;
  if (detail === undefined) {
    process.stderr.write(`${line}\n`);
  } else {
    const text = detail instanceof Error ? (detail.stack ?? detail.message) : JSON.stringify(detail);
    process.stderr.write(`${line} ${text}\n`);
  }
}

export const logger = {
  debug: (message: string, detail?: unknown) => write('debug', message, detail),
  info: (message: string, detail?: unknown) => write('info', message, detail),
  warn: (message: string, detail?: unknown) => write('warn', message, detail),
  error: (message: string, detail?: unknown) => write('error', message, detail),
};
