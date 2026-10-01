// Logger `pino` de Fastify escribiendo en memoria, para comprobar los eventos de log en los tests.

import { fastify, type FastifyBaseLogger } from 'fastify';

export type LogLine = Record<string, unknown>;

export interface LogCapture {
  logger: FastifyBaseLogger;
  /** Líneas con ese `event`, en orden. */
  events(name: string): LogLine[];
}

export function captureLogs(): LogCapture {
  const lines: LogLine[] = [];
  const stream = {
    write(chunk: string): void {
      lines.push(JSON.parse(chunk) as LogLine);
    },
  };
  const { log } = fastify({ logger: { level: 'trace', stream } });
  return {
    logger: log,
    events: (name) => lines.filter((line) => line.event === name),
  };
}
