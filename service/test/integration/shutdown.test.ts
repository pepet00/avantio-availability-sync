// La parada se prueba sobre el proceso real (src/index.ts) con SIGTERM: así se cubren las señales y
// el orden de cierre tal como corren en producción. El proceso hijo no comparte el desplazamiento del
// reloj controlado, así que aquí el reloj va sin desplazar y las fechas son relativas al "hoy" real.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { now } from '../../src/clock.js';
import { addDays, todayUtc, type Day } from '../../src/dates.js';
import { connectStorage, type Storage } from '../../src/storage/mongo.js';
import type { AccommodationDoc } from '../../src/storage/types.js';
import {
  NO_RESPONSE,
  ok,
  rateLimited,
  startFakePortal,
  type FakePortal,
  type FakeResponse,
} from '../helpers/fake-portal.js';
import { startTestMongo, type TestMongo } from '../helpers/mongo.js';
import { waitFor } from '../helpers/wait-for.js';

const serviceDir = fileURLToPath(new URL('../..', import.meta.url));
const entry = ['--import', 'tsx', 'src/index.ts'];
const ID = 'acc-1003';
const SHUTDOWN_TIMEOUT_MS = 10_000;

type LogLine = Record<string, unknown>;

interface Exit {
  code: number | null;
  /** Desde el SIGTERM hasta que el proceso termina. */
  elapsedMs: number;
  /** Instante de salida medido con `performance.now()`. */
  exitedAtMs: number;
}

interface ServiceProcess {
  url: string;
  events(name: string): LogLine[];
  /** Envía SIGTERM y espera a que el proceso termine. */
  stop(): Promise<Exit>;
}

function day(offset: number): Day {
  return addDays(todayUtc(now()), offset);
}

describe('parada ordenada', () => {
  let mongo: TestMongo;
  let portal: FakePortal;
  let mongoUrl: string;
  let storage: Storage;
  let children: ChildProcessWithoutNullStreams[] = [];

  beforeAll(async () => {
    mongo = await startTestMongo();
    portal = await startFakePortal();
  }, 120_000);

  afterAll(async () => {
    await portal.close();
    await mongo.stop();
  });

  beforeEach(async () => {
    portal.reset();
    mongoUrl = mongo.freshUrl();
    storage = await connectStorage(mongoUrl);
  });

  afterEach(async () => {
    portal.reset();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
    children = [];
    await storage.close();
  });

  /** Arranca el servicio en su propio proceso, con tiempos cortos, y espera a que el worker arranque. */
  async function spawnService(env: Record<string, string> = {}): Promise<ServiceProcess> {
    const child = spawn(process.execPath, entry, {
      cwd: serviceDir,
      env: {
        ...process.env,
        PORT: '0',
        LOG_LEVEL: 'info',
        MONGO_URL: mongoUrl,
        PORTAL_URL: portal.url,
        PORTAL_TIMEOUT_MS: '5000',
        WORKER_IDLE_MS: '10',
        SHUTDOWN_TIMEOUT_MS: String(SHUTDOWN_TIMEOUT_MS),
        ...env,
      },
    });
    children.push(child);
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // Sin leer stderr, un búfer lleno bloquearía al hijo.
    child.stderr.resume();
    const exited = once(child, 'exit').then(() => performance.now());

    const events = (name: string): LogLine[] =>
      stdout
        .split('\n')
        .slice(0, -1)
        .map((line) => JSON.parse(line) as LogLine)
        .filter((line) => line.event === name);

    const started = await waitFor(() => events('server.started')[0], { timeoutMs: 15_000, message: 'server.started' });
    await waitFor(() => events('worker.started').length === 1, { message: 'worker.started' });

    return {
      url: `http://127.0.0.1:${String(started.port)}`,
      events,
      stop: async () => {
        const signalledAtMs = performance.now();
        child.kill('SIGTERM');
        const exitedAtMs = await exited;
        return { code: child.exitCode, elapsedMs: exitedAtMs - signalledAtMs, exitedAtMs };
      },
    };
  }

  async function post(service: ServiceProcess, from: Day, to: Day): Promise<void> {
    const response = await fetch(`${service.url}/updates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accommodationId: ID, from, to, available: true, pricePerNight: 100 }),
    });
    expect(response.status).toBe(202);
  }

  async function load(): Promise<AccommodationDoc> {
    const doc = await storage.accommodations.findOne({ _id: ID });
    if (doc === null) throw new Error(`No existe el documento de ${ID}`);
    return doc;
  }

  it('con un PUT en curso espera a esa petición, libera el lease y cierra dentro de SHUTDOWN_TIMEOUT_MS', async () => {
    const held = Promise.withResolvers<FakeResponse>();
    portal.enqueue(() => held.promise);
    const service = await spawnService();
    await post(service, day(1), day(3));
    await waitFor(() => portal.requests.length === 1, { message: 'el PUT' });

    const stopped = service.stop();
    // La parada ya ha empezado (el servidor HTTP deja de atender) y el PUT sigue en camino.
    await waitFor(
      async () => {
        try {
          return (await fetch(`${service.url}/metrics`)).status === 503;
        } catch {
          return true;
        }
      },
      { message: 'que el servidor HTTP deje de atender' },
    );
    held.resolve(ok());
    const exit = await stopped;

    expect(exit.code).toBe(0);
    expect(exit.elapsedMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    // El 200 se guardó antes de cerrar: se esperó a la petición.
    const doc = await load();
    expect(doc).toMatchObject({ status: 'synced', pending: false, leaseUntil: null });
    expect(portal.requests).toHaveLength(1);
    expect(service.events('worker.stopped')).toHaveLength(1);
  }, 30_000);

  interface WaitCase {
    wait: string;
    env: Record<string, string>;
    setup: (service: ServiceProcess) => Promise<void>;
    /** El worker ya está en la espera. */
    inWait: (service: ServiceProcess) => boolean | Promise<boolean>;
    /** PUT que llegan al portal antes de la espera. */
    sent: number;
  }

  it.each<WaitCase>([
    {
      wait: 'el sueño del bucle',
      env: { WORKER_IDLE_MS: '60000' },
      setup: async (): Promise<void> => {},
      inWait: (): boolean => true,
      sent: 0,
    },
    {
      wait: 'el limitador',
      env: { PORTAL_RATE_LIMIT: '1' },
      // 32 días: dos PUT; el segundo espera a que pase la ventana de 60 s.
      setup: (service: ServiceProcess) => post(service, day(1), day(32)),
      inWait: async (): Promise<boolean> => (await load()).days[day(1)]?.syncedVersion === 1,
      sent: 1,
    },
    {
      wait: 'la pausa por 429',
      env: {},
      setup: (service: ServiceProcess) => {
        portal.enqueue(rateLimited(60));
        return post(service, day(1), day(3));
      },
      inWait: (service: ServiceProcess): boolean => service.events('portal.rate_limited').length === 1,
      sent: 1,
    },
  ])('durante $wait: la espera se interrumpe y no se envía nada más', async ({ env, setup, inWait, sent }) => {
    const service = await spawnService(env);
    await setup(service);
    await waitFor(() => inWait(service), { message: 'que el worker esté esperando' });

    const exit = await service.stop();

    // Código 0: terminó por sí mismo, sin agotar SHUTDOWN_TIMEOUT_MS ni esperar los 60 s.
    expect(exit.code).toBe(0);
    expect(exit.elapsedMs).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    expect(portal.requests).toHaveLength(sent);
    if (sent > 0) expect((await load()).leaseUntil).toBeNull();
    expect(service.events('worker.stopped')).toHaveLength(1);
  }, 30_000);

  it('si el portal no responde, no espera más que el timeout de la petición', async () => {
    const timeoutMs = 1_000;
    portal.setDefault(NO_RESPONSE);
    const service = await spawnService({ PORTAL_TIMEOUT_MS: String(timeoutMs) });
    await post(service, day(1), day(3));
    const put = await waitFor(() => portal.requests[0], { message: 'el PUT' });

    const exit = await service.stop();

    expect(exit.code).toBe(0);
    // El timeout de la petición más lo que tarda en cerrar; muy lejos de SHUTDOWN_TIMEOUT_MS.
    expect(exit.exitedAtMs - put.receivedAtMs).toBeLessThan(timeoutMs + 1_000);
    const doc = await load();
    expect(doc).toMatchObject({ status: 'pending', leaseUntil: null });
    expect(doc.lastError?.code).toBe('TIMEOUT');
    expect(portal.requests).toHaveLength(1);
  }, 30_000);
});
