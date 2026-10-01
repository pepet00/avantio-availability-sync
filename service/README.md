# Servicio de sincronización de disponibilidad

Recibe cambios de disponibilidad y precio de alojamientos, los guarda en MongoDB y los sincroniza con Portal Sol respetando sus límites.

- Diseño y decisiones: [`SPEC.md`](../SPEC.md)
- Cómo se trabajó con IA: [`PROCESS.md`](../PROCESS.md)

## Requisitos

- Node.js 24 o superior
- Docker Desktop actualizado (para MongoDB y Portal Sol, y para los tests E2E). Con un kernel de la VM entre 6.19 y 7.0.13, MongoDB 8 no arranca (SERVER-121912); actualizar Docker Desktop lo resuelve.

## Arranque

Desde la raíz del repositorio, levanta Portal Sol y MongoDB:

```bash
docker compose --profile mongo up -d
curl http://localhost:4000/health   # → {"status":"ok",...}
```

Desde `service/`:

```bash
npm install
npm run dev
```

El servicio escucha en `http://localhost:3000`.

## Configuración

Todas las variables de entorno y sus valores por defecto están en la sección *Configuración* de [`SPEC.md`](../SPEC.md). Los valores por defecto sirven para el entorno local del `docker-compose`.

## Uso

Enviar un cambio (las fechas deben ser de hoy o posteriores; el portal de demo acepta fechas más allá de sus 90 días iniciales):

```bash
curl -X POST http://localhost:3000/updates \
  -H 'Content-Type: application/json' \
  -d '{"accommodationId":"acc-1003","from":"2027-06-01","to":"2027-06-07","available":false,"pricePerNight":120}'
```

Consultar el estado de sincronización:

```bash
curl http://localhost:3000/accommodations/acc-1003/sync-status
```

Métricas en formato Prometheus:

```bash
curl http://localhost:3000/metrics
```

## Calidad y tests

Desde `service/`:

```bash
npm run lint        # ESLint
npm run typecheck   # Comprobación de tipos
npm test            # Unitarios e integración. No necesitan Docker.
npm run test:e2e    # E2E contra el Portal Sol real. Requiere el docker-compose levantado.
```

`npm test` arranca un MongoDB temporal con `mongodb-memory-server`. La primera ejecución descarga el binario de MongoDB, así que necesita conexión a internet y tarda más.

`npm run test:e2e` arranca el servicio dentro del propio test contra el Portal Sol y el MongoDB del `docker-compose`. Al empezar llama a `POST /__admin/reset` del portal y borra la base `sync-e2e` (no toca la base `sync` de `npm run dev`). El limitador se pone por encima del límite del portal para forzar algún `429`, así que tarda unos minutos. Como el portal falla y tarda al azar, la duración cambia de una ejecución a otra.

## Estructura

```
src/
  index.ts         Arranque: configuración, MongoDB, reset de leases, barrido, HTTP y worker
  lifecycle.ts     Parada ordenada (SIGTERM/SIGINT) con tiempo máximo
  app.ts           Fastify: rutas, manejador de errores y log http.request
  config.ts        Variables de entorno de la SPEC, validadas
  clock.ts         now(): único origen de instantes; desplazable en tests
  dates.ts         Días de calendario YYYY-MM-DD en UTC (validación y aritmética)
  errors.ts        Errores con la forma { error: { code, message } }
  updates/         POST /updates: validación (pura) y ruta
  status/          GET /accommodations/:id/sync-status
  metrics/         Registro de métricas Prometheus y GET /metrics
  storage/         Conexión e índices de MongoDB, tipo del documento y repositorio (concurrencia por rev, lease)
  portal/          Cliente único del portal (timeout, clasificación de respuestas) y limitador (ventana deslizante, pausa por 429)
  sync/            Worker, barrido de días pasados y funciones puras: transiciones de estado, agrupación en rangos y backoff
test/
  unit/            Funciones puras, sin MongoDB ni red
  integration/     Servicio completo contra MongoDB en memoria y el portal falso
  e2e/             Contra el Portal Sol real (npm run test:e2e)
  helpers/         Portal falso, MongoDB en memoria, arranque del servicio, captura de logs y espera por condición
```

## Mejoras futuras

- **Sustituir `prom-client`**: la versión 15.1.3 está marcada en npm como deprecada en favor de `@prometheus-io/client`. Funciona y se mantiene por ahora; el cambio queda dentro de `src/metrics/`.
