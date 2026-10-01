import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, type Config, type Env } from '../../src/config.js';

function configError(env: Env): ConfigError {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  return expect.fail('loadConfig debía lanzar ConfigError');
}

describe('loadConfig', () => {
  it('sin entorno devuelve los valores por defecto de la SPEC', () => {
    expect(loadConfig({})).toEqual<Config>({
      port: 3000,
      mongoUrl: 'mongodb://localhost:27017/sync',
      portalUrl: 'http://localhost:4000',
      portalApiKey: 'sol-demo-key',
      portalRateLimit: 25,
      portalTimeoutMs: 15_000,
      timeoutGraceMs: 30_000,
      backoffBaseMs: 2_000,
      backoffMaxMs: 300_000,
      failingThreshold: 5,
      leaseMs: 120_000,
      workerIdleMs: 1_000,
      shutdownTimeoutMs: 20_000,
      logLevel: 'info',
    });
  });

  it('lee cada variable del entorno con su tipo', () => {
    const env = {
      PORT: '8080',
      MONGO_URL: 'mongodb+srv://user:secret@cluster.example/sync',
      PORTAL_URL: 'https://portal.example',
      PORTAL_API_KEY: 'otra-clave',
      PORTAL_RATE_LIMIT: '100',
      PORTAL_TIMEOUT_MS: '200',
      TIMEOUT_GRACE_MS: '300',
      BACKOFF_BASE_MS: '10',
      BACKOFF_MAX_MS: '50',
      FAILING_THRESHOLD: '3',
      LEASE_MS: '1000',
      WORKER_IDLE_MS: '20',
      SHUTDOWN_TIMEOUT_MS: '2000',
      LOG_LEVEL: 'silent',
    };

    expect(loadConfig(env)).toEqual<Config>({
      port: 8080,
      mongoUrl: 'mongodb+srv://user:secret@cluster.example/sync',
      portalUrl: 'https://portal.example',
      portalApiKey: 'otra-clave',
      portalRateLimit: 100,
      portalTimeoutMs: 200,
      timeoutGraceMs: 300,
      backoffBaseMs: 10,
      backoffMaxMs: 50,
      failingThreshold: 3,
      leaseMs: 1000,
      workerIdleMs: 20,
      shutdownTimeoutMs: 2000,
      logLevel: 'silent',
    });
  });

  it('acepta los valores límite', () => {
    expect(loadConfig({ PORT: '0' }).port).toBe(0);
    expect(loadConfig({ PORT: '65535' }).port).toBe(65_535);
    expect(loadConfig({ PORTAL_TIMEOUT_MS: '2147483647' }).portalTimeoutMs).toBe(2_147_483_647);
    expect(loadConfig({ LEASE_MS: '3600000' }).leaseMs).toBe(3_600_000);
    expect(loadConfig({ TIMEOUT_GRACE_MS: '600000' }).timeoutGraceMs).toBe(600_000);
    expect(loadConfig({ BACKOFF_BASE_MS: '600000', BACKOFF_MAX_MS: '3600000' })).toMatchObject({
      backoffBaseMs: 600_000,
      backoffMaxMs: 3_600_000,
    });
    expect(loadConfig({ BACKOFF_BASE_MS: '500', BACKOFF_MAX_MS: '500' }).backoffMaxMs).toBe(500);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', ''],
    ['PORT', '-1'],
    ['PORT', '3.5'],
    ['PORT', ' 3000'],
    ['PORT', '65536'],
    ['MONGO_URL', 'localhost:27017/sync'],
    ['MONGO_URL', ''],
    ['PORTAL_URL', 'no es una url'],
    ['PORTAL_URL', 'ftp://portal.example'],
    ['PORTAL_API_KEY', ''],
    ['PORTAL_RATE_LIMIT', '0'],
    ['PORTAL_TIMEOUT_MS', '15s'],
    ['PORTAL_TIMEOUT_MS', '2147483648'],
    ['TIMEOUT_GRACE_MS', '0'],
    ['TIMEOUT_GRACE_MS', '600001'],
    ['BACKOFF_BASE_MS', '-5'],
    ['BACKOFF_BASE_MS', '600001'],
    ['BACKOFF_MAX_MS', '1e5'],
    ['BACKOFF_MAX_MS', '3600001'],
    ['FAILING_THRESHOLD', '2.5'],
    ['LEASE_MS', '0'],
    ['LEASE_MS', '3600001'],
    ['WORKER_IDLE_MS', ''],
    ['WORKER_IDLE_MS', '2147483648'],
    ['SHUTDOWN_TIMEOUT_MS', 'NaN'],
    ['SHUTDOWN_TIMEOUT_MS', '2147483648'],
    ['LOG_LEVEL', 'verbose'],
  ])('%s=%j es inválido y el error nombra la variable', (variable, value) => {
    const error = configError({ [variable]: value });

    expect(error.variables).toEqual([variable]);
    expect(error.message).toContain(`${variable}:`);
  });

  it('BACKOFF_MAX_MS menor que BACKOFF_BASE_MS es inválido', () => {
    const error = configError({ BACKOFF_BASE_MS: '5000', BACKOFF_MAX_MS: '1000' });

    expect(error.variables).toEqual(['BACKOFF_MAX_MS']);
  });

  it('con varias variables inválidas, el error las nombra todas', () => {
    const error = configError({ PORT: 'abc', LOG_LEVEL: 'verbose', FAILING_THRESHOLD: '0' });

    expect(error.variables).toEqual(['PORT', 'FAILING_THRESHOLD', 'LOG_LEVEL']);
    for (const variable of error.variables) {
      expect(error.message).toContain(`${variable}:`);
    }
  });
});
