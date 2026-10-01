// Cliente único del portal: todas las llamadas del servicio a Portal Sol pasan por aquí
// (limitador, pausa por `429`, timeout y clasificación del resultado). Solo implementa el PUT;
// nunca llama a `/__admin` (invariante 7).

import type { FastifyBaseLogger } from 'fastify';
import { now } from '../clock.js';
import type { Config } from '../config.js';
import { compareDays, daysInRange, parseDay, parseHttpDate } from '../dates.js';
import { MAX_RANGE_DAYS } from '../sync/grouping.js';
import { RateLimiter } from './limiter.js';

export type PortalOutcome =
  | 'success'
  | 'rate_limited'
  | 'unavailable'
  | 'server_error'
  | 'timeout'
  | 'connection_error'
  | 'not_found'
  | 'bad_request'
  | 'unauthorized';

export type FailureOutcome = Exclude<PortalOutcome, 'success' | 'rate_limited'>;

/** Estado de un rango tal como lo recibe el portal. */
export interface PortalRange {
  from: string;
  to: string;
  available: boolean;
  pricePerNight: number;
}

export interface PortalError {
  code: string;
  message: string;
}

export type PutResult =
  | { outcome: 'success'; status: number; durationMs: number }
  | { outcome: 'rate_limited'; status: 429; retryAfterMs: number; durationMs: number }
  | { outcome: FailureOutcome; status: number | null; error: PortalError; durationMs: number };

export type PortalClientConfig = Pick<Config, 'portalUrl' | 'portalApiKey' | 'portalRateLimit' | 'portalTimeoutMs'>;

export interface PortalClientOptions {
  logger: FastifyBaseLogger;
  /** Longitud de la ventana del limitador. Parámetro interno, no variable de entorno: los tests la acortan. */
  windowMs?: number;
  /** Pausa tras un `429` sin `Retry-After` válido. Parámetro interno, como la ventana. */
  defaultRetryAfterMs?: number;
}

export interface PutOptions {
  /** Interrumpe las esperas del limitador y de la pausa. No corta una petición ya enviada. */
  signal?: AbortSignal;
}

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 60_000;

export class PortalClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly defaultRetryAfterMs: number;
  private readonly logger: FastifyBaseLogger;
  private readonly limiter: RateLimiter;

  constructor(config: PortalClientConfig, options: PortalClientOptions) {
    this.baseUrl = config.portalUrl.replace(/\/+$/, '');
    this.apiKey = config.portalApiKey;
    this.timeoutMs = config.portalTimeoutMs;
    this.defaultRetryAfterMs = options.defaultRetryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.logger = options.logger;
    this.limiter = new RateLimiter({
      limit: config.portalRateLimit,
      windowMs: options.windowMs ?? DEFAULT_WINDOW_MS,
    });
  }

  /**
   * Envía un rango al portal. Espera antes lo que digan el limitador y la pausa; si `signal`
   * se aborta mientras tanto, rechaza sin enviar nada. Ante un `429` no reintenta: activa la
   * pausa y devuelve `rate_limited`, para que quien llama reenvíe el estado vigente.
   *
   * Un rango con fechas inválidas o de más de 31 días es un error de programación (la agrupación
   * nunca los genera): lanza `RangeError` sin enviar nada (invariante 6).
   *
   * Limitación con envíos concurrentes: entre que `acquire` da paso y sale el `fetch` hay un
   * `await`, así que un `429` recibido por otro `put` justo en ese hueco no frena esta petición.
   * Con el worker, que envía de uno en uno, no ocurre.
   */
  async put(accommodationId: string, range: PortalRange, options: PutOptions = {}): Promise<PutResult> {
    assertSendableRange(range);
    await this.limiter.acquire(options.signal);

    const url = `${this.baseUrl}/api/v1/accommodations/${encodeURIComponent(accommodationId)}/availability`;
    const body: PortalRange = {
      from: range.from,
      to: range.to,
      available: range.available,
      pricePerNight: range.pricePerNight,
    };
    const started = performance.now();
    const elapsed = (): number => Math.round(performance.now() - started);

    let status: number;
    let retryAfterHeader: string | null;
    let text: string;
    try {
      // El timeout cubre también la lectura del cuerpo.
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'X-Api-Key': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      status = response.status;
      retryAfterHeader = response.headers.get('retry-after');
      text = await response.text();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        return {
          outcome: 'timeout',
          status: null,
          error: { code: 'TIMEOUT', message: `Sin respuesta tras ${String(this.timeoutMs / 1000)} s` },
          durationMs: elapsed(),
        };
      }
      return {
        outcome: 'connection_error',
        status: null,
        error: { code: 'CONNECTION_ERROR', message: connectionErrorMessage(error) },
        durationMs: elapsed(),
      };
    }
    const durationMs = elapsed();

    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(retryAfterHeader) ?? this.defaultRetryAfterMs;
      this.limiter.pause(retryAfterMs);
      this.logger.warn(
        {
          event: 'portal.rate_limited',
          accommodationId,
          from: range.from,
          to: range.to,
          status,
          retryAfter: retryAfterMs / 1000,
          durationMs,
        },
        'El portal pide esperar',
      );
      return { outcome: 'rate_limited', status, retryAfterMs, durationMs };
    }

    const json = parseJson(text);
    if (json === undefined) {
      return {
        outcome: 'server_error',
        status,
        error: { code: 'INVALID_RESPONSE', message: `Respuesta ${String(status)} sin cuerpo JSON` },
        durationMs,
      };
    }

    const outcome = outcomeForStatus(status);
    if (outcome === 'success') {
      return { outcome, status, durationMs };
    }
    return { outcome, status, error: portalError(json, outcome, status), durationMs };
  }
}

/** Clasifica una respuesta con cuerpo JSON. El `429` y el cuerpo que no es JSON se tratan antes. */
function outcomeForStatus(status: number): Exclude<PortalOutcome, 'rate_limited' | 'timeout' | 'connection_error'> {
  if (status >= 200 && status < 300) return 'success';
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status >= 400 && status < 500) return 'bad_request';
  if (status === 503) return 'unavailable';
  return 'server_error';
}

const FALLBACK_CODES: Record<FailureOutcome, string> = {
  unavailable: 'UNAVAILABLE',
  server_error: 'SERVER_ERROR',
  timeout: 'TIMEOUT',
  connection_error: 'CONNECTION_ERROR',
  not_found: 'NOT_FOUND',
  bad_request: 'BAD_REQUEST',
  unauthorized: 'UNAUTHORIZED',
};

/** El error con la forma del portal, `{ error: { code, message } }`, o uno derivado del resultado. */
function portalError(json: unknown, outcome: FailureOutcome, status: number): PortalError {
  if (isRecord(json) && isRecord(json.error)) {
    const { code, message } = json.error;
    if (typeof code === 'string' && code !== '') {
      return { code, message: typeof message === 'string' ? message : `HTTP ${String(status)}` };
    }
  }
  return { code: FALLBACK_CODES[outcome], message: `HTTP ${String(status)}` };
}

function assertSendableRange({ from, to }: PortalRange): void {
  const fromDay = parseDay(from);
  const toDay = parseDay(to);
  if (fromDay === null || toDay === null || compareDays(toDay, fromDay) < 0) {
    throw new RangeError(`Rango inválido para el portal: ${from} → ${to}`);
  }
  const days = daysInRange(fromDay, toDay);
  if (days > MAX_RANGE_DAYS) {
    throw new RangeError(
      `Rango de ${String(days)} días para el portal (máximo ${String(MAX_RANGE_DAYS)}): ${from} → ${to}`,
    );
  }
}

/**
 * `Retry-After` en segundos o como fecha HTTP (IMF-fixdate). La fecha se compara con `now()`
 * una sola vez, al recibirla; a partir de ahí la pausa es una duración. Una fecha pasada no pausa.
 * `undefined` si falta la cabecera o no se puede interpretar.
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = parseHttpDate(trimmed);
  return date === null ? undefined : Math.max(0, date.getTime() - now().getTime());
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function connectionErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause: unknown = error.cause;
    if (cause instanceof Error && cause.message !== '') return cause.message;
    return error.message;
  }
  return String(error);
}
