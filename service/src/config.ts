export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  port: number;
  mongoUrl: string;
  portalUrl: string;
  portalApiKey: string;
  portalRateLimit: number;
  portalTimeoutMs: number;
  timeoutGraceMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  failingThreshold: number;
  leaseMs: number;
  workerIdleMs: number;
  shutdownTimeoutMs: number;
  logLevel: LogLevel;
}

export type Env = Readonly<Record<string, string | undefined>>;

interface Problem {
  variable: string;
  expected: string;
}

export class ConfigError extends Error {
  readonly variables: readonly string[];

  constructor(problems: readonly Problem[]) {
    const lines = problems.map((p) => `- ${p.variable}: debe ser ${p.expected}`);
    super(`Configuración inválida:\n${lines.join('\n')}`);
    this.name = 'ConfigError';
    this.variables = problems.map((p) => p.variable);
  }
}

interface Parser<T> {
  parse: (raw: string) => T | undefined;
  expected: string;
}

function integerIn(min: number, max: number): Parser<number> {
  return {
    parse: (raw) => {
      if (!/^\d+$/.test(raw)) return undefined;
      const value = Number(raw);
      return value >= min && value <= max ? value : undefined;
    },
    expected: `un entero entre ${String(min)} y ${String(max)}`,
  };
}

const positiveInteger: Parser<number> = {
  parse: integerIn(1, Number.MAX_SAFE_INTEGER).parse,
  expected: 'un entero mayor que 0',
};

// Para las esperas que se pasan a un timer: setTimeout no admite más de 2^31−1 ms
// (con más, dispara al instante). Las que se suman a instantes no tienen ese límite.
const timerMs = integerIn(1, 2_147_483_647);

// Los que se suman a instantes (now() + …) tienen topes razonables: con más, un alojamiento
// quedaría bloqueado horas, y con valores absurdos la suma daría una fecha inválida.
const leaseMs = integerIn(1, 3_600_000);
const timeoutGraceMs = integerIn(1, 600_000);
const backoffBaseMs = integerIn(1, 600_000);
const backoffMaxMs = integerIn(1, 3_600_000);

const nonEmptyText: Parser<string> = {
  parse: (raw) => (raw === '' ? undefined : raw),
  expected: 'un texto no vacío',
};

const mongoUrl: Parser<string> = {
  parse: (raw) => (/^mongodb(\+srv)?:\/\/./.test(raw) ? raw : undefined),
  expected: 'una URL mongodb:// o mongodb+srv://',
};

const httpUrl: Parser<string> = {
  parse: (raw) => {
    const url = URL.parse(raw);
    return url !== null && (url.protocol === 'http:' || url.protocol === 'https:') ? raw : undefined;
  },
  expected: 'una URL http:// o https://',
};

const logLevel: Parser<LogLevel> = {
  parse: (raw) => LOG_LEVELS.find((level) => level === raw),
  expected: `uno de ${LOG_LEVELS.join(', ')}`,
};

/** Lee la configuración del entorno. Lanza `ConfigError` nombrando cada variable inválida. */
export function loadConfig(env: Env = process.env): Config {
  const problems: Problem[] = [];

  function read<T>(variable: string, defaultValue: T, parser: Parser<T>): T {
    const raw = env[variable];
    if (raw === undefined) return defaultValue;
    const value = parser.parse(raw);
    if (value === undefined) {
      problems.push({ variable, expected: parser.expected });
      return defaultValue;
    }
    return value;
  }

  const config: Config = {
    port: read('PORT', 3000, integerIn(0, 65_535)),
    mongoUrl: read('MONGO_URL', 'mongodb://localhost:27017/sync', mongoUrl),
    portalUrl: read('PORTAL_URL', 'http://localhost:4000', httpUrl),
    portalApiKey: read('PORTAL_API_KEY', 'sol-demo-key', nonEmptyText),
    portalRateLimit: read('PORTAL_RATE_LIMIT', 25, positiveInteger),
    portalTimeoutMs: read('PORTAL_TIMEOUT_MS', 15_000, timerMs),
    timeoutGraceMs: read('TIMEOUT_GRACE_MS', 30_000, timeoutGraceMs),
    backoffBaseMs: read('BACKOFF_BASE_MS', 2_000, backoffBaseMs),
    backoffMaxMs: read('BACKOFF_MAX_MS', 300_000, backoffMaxMs),
    failingThreshold: read('FAILING_THRESHOLD', 5, positiveInteger),
    leaseMs: read('LEASE_MS', 120_000, leaseMs),
    workerIdleMs: read('WORKER_IDLE_MS', 1_000, timerMs),
    shutdownTimeoutMs: read('SHUTDOWN_TIMEOUT_MS', 20_000, timerMs),
    logLevel: read('LOG_LEVEL', 'info', logLevel),
  };

  const backoffValid = !problems.some((p) => p.variable.startsWith('BACKOFF_'));
  if (backoffValid && config.backoffMaxMs < config.backoffBaseMs) {
    problems.push({ variable: 'BACKOFF_MAX_MS', expected: 'mayor o igual que BACKOFF_BASE_MS' });
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
