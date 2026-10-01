import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const serviceDir = fileURLToPath(new URL('../..', import.meta.url));
const entry = ['--import', 'tsx', 'src/index.ts'];

type LogLine = Record<string, unknown>;

/** Líneas JSON completas escritas hasta ahora (la última puede estar a medias). */
function logLines(output: string): LogLine[] {
  return output
    .split('\n')
    .slice(0, -1)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) throw new Error(`Línea de log no es un objeto: ${line}`);
      return parsed as LogLine;
    });
}

describe('arranque', () => {
  it('con un valor de entorno inválido no arranca y el error nombra la variable', () => {
    // Si llegara a escuchar, no terminaría solo: el timeout lo mata y el test falla.
    const result = spawnSync(process.execPath, entry, {
      cwd: serviceDir,
      env: { ...process.env, PORT: 'abc' },
      encoding: 'utf8',
      timeout: 10_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PORT:');
    expect(result.stdout).not.toContain('event');
  }, 15_000);

  it('con configuración válida escucha, registra server.started y cada petición con http.request', async () => {
    const child = spawn(process.execPath, entry, {
      cwd: serviceDir,
      env: { ...process.env, PORT: '0', LOG_LEVEL: 'info' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    try {
      const started = await vi.waitFor(
        () => {
          const line = logLines(stdout).find((l) => l.event === 'server.started');
          if (line === undefined) throw new Error('El servicio aún no ha arrancado');
          return line;
        },
        { timeout: 10_000, interval: 50 },
      );
      expect(typeof started.port).toBe('number');
      expect(started.port).toBeGreaterThan(0);

      const response = await fetch(`http://127.0.0.1:${String(started.port)}/no-existe?x=1`);
      expect(response.status).toBe(404);

      const request = await vi.waitFor(() => {
        const line = logLines(stdout).find((l) => l.event === 'http.request');
        if (line === undefined) throw new Error('Aún no se ha registrado la petición');
        return line;
      });
      expect(request).toMatchObject({ method: 'GET', url: '/no-existe?x=1', statusCode: 404 });
      expect(typeof request.reqId).toBe('string');
      expect(typeof request.durationMs).toBe('number');

      // Ni "Server listening at…" ni los logs de petición de Fastify: todas llevan `event`.
      for (const line of logLines(stdout)) {
        expect(line).toHaveProperty('event');
      }
      // Ni avisos de Node o Fastify (por ejemplo, de opciones obsoletas).
      expect(stderr).toBe('');
    } finally {
      child.kill();
      if (child.exitCode === null) await once(child, 'exit');
    }
  }, 15_000);
});
