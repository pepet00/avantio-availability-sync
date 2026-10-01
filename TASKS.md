# TASKS — Servicio de sincronización de disponibilidad

Tareas para implementar [`SPEC.md`](./SPEC.md), ordenadas de lo que no depende de nada a lo que depende de todo. Las reglas de trabajo y la definición de "hecho" están en [`CLAUDE.md`](./CLAUDE.md).

- Las rutas de fichero son relativas a `service/`, salvo que se indique otra cosa.
- **Ficheros previstos** es una previsión: si una tarea necesita otro fichero, se usa y se dice al terminar. `(mod)` marca un fichero creado en una tarea anterior.
- **Tests** lista lo mínimo que la tarea debe dejar probado. Los tests de las tareas anteriores siguen pasando.
- La casilla se marca en el mismo commit que cierra la tarea.

---

## T1 — Esqueleto del proyecto

- [x] Hecha

**Objetivo**: dejar `service/` con herramientas, comandos, configuración y reloj, y un servidor Fastify vacío que arranca con `npm run dev`.

**Depende de**: nada.

**Ficheros previstos**: `package.json`, `package-lock.json`, `tsconfig.json` (modo `strict`), `eslint.config.js`, `vitest.config.ts`, `vitest.e2e.config.ts`, `src/config.ts` (variables de la sección *Configuración*, con sus valores por defecto), `src/clock.ts` (`now()` y desplazamiento para tests), `src/app.ts` (Fastify con su logger `pino` a `LOG_LEVEL`, sin rutas), `src/index.ts` (escucha en `PORT`), `test/unit/config.test.ts`, `test/unit/clock.test.ts`. Se borra `.gitkeep`.

**Tests**:
- Configuración: sin entorno devuelve los valores por defecto de la SPEC; con entorno, los lee con su tipo.
- Configuración: con un valor inválido (por ejemplo, `PORT=abc`), la carga falla con un error que nombra la variable y el servicio no arranca (`src/index.ts` carga la configuración antes de conectar o escuchar).
- Reloj: `now()` sigue la hora real; con desplazamiento salta hacia delante y sigue avanzando (no se congela).

**CA**: ninguno. Crea los comandos `dev`, `lint`, `typecheck`, `test` y `test:e2e` (este último no tendrá tests hasta T14). Solo las dependencias previstas en `CLAUDE.md`.

---

## T2 — Módulo de fechas

- [x] Hecha

**Objetivo**: reunir en un módulo puro toda la validación y aritmética de días de calendario en UTC.

**Depende de**: T1.

**Ficheros previstos**: `src/dates.ts` (validar `YYYY-MM-DD` con ida y vuelta, "hoy" a partir de un instante, sumar días, contar días de un rango inclusivo, comparar, enumerar un rango), `test/unit/dates.test.ts`.

**Tests** (unitarios, con fechas fijas):
- `2026-02-30` y `2026-02-29` se rechazan; `2028-02-29` se acepta; textos con otro formato se rechazan.
- Un rango que cruza fin de mes y otro que cruza el cambio de hora del 25 de octubre de 2026 no repiten ni saltan días.
- "Hoy" es el día UTC del instante recibido (23:59:59Z y 00:00:00Z caen en días distintos).
- El número de días de un rango inclusivo es correcto (mismo día = 1).

**CA**: CA-7 (unitario, parte de fechas).

---

## T3 — Agrupación en rangos y backoff

- [x] Hecha

**Objetivo**: calcular como funciones puras los rangos que se enviarán al portal y el retraso de cada reintento.

**Depende de**: T2.

**Ficheros previstos**: `src/sync/grouping.ts`, `src/sync/backoff.ts`, `test/unit/grouping.test.ts`, `test/unit/backoff.test.ts`.

**Tests** (unitarios):
- Agrupación: un hueco abre grupo; un cambio de `available` o de precio abre grupo; 31, 32 y 90 días iguales dan exactamente 1, 2 y 3 grupos (90 días desde el 1 de octubre: 1–31 oct, 1 nov–1 dic, 2–29 dic).
- Solo entran los días pendientes (`version > syncedVersion`) de hoy o posteriores; los pasados y los ya sincronizados se ignoran.
- Para cualquier entrada, los grupos cubren cada día pendiente exactamente una vez y ninguno supera los 31 días.
- Backoff: `min(base × 2^(attempts−1), tope)` crece con `attempts` y nunca supera el tope; con *full jitter* el resultado queda entre 0 y ese valor (fuente de azar inyectable).

**CA**: CA-3 (unitario), CA-7 (unitario, parte de rangos).

---

## T4 — Portal falso y cliente del portal

- [x] Hecha

**Objetivo**: crear el cliente único por el que pasan todas las llamadas al portal (limitador de ventana deslizante, pausa global por `429`, timeout y clasificación del resultado) y el portal falso con el que se prueba.

**Depende de**: T1.

**Ficheros previstos**: `src/portal/limiter.ts`, `src/portal/client.ts`, `test/helpers/fake-portal.ts` (responde lo que el test indique —`200`, `429` con `Retry-After`, `503`, `404` o no responder— y registra cada petición con su hora), `test/helpers/wait-for.ts` (espera por condición con tiempo máximo), `test/integration/portal-client.test.ts`.

**Tests** (integración contra el portal falso, sin MongoDB):
- El `PUT` lleva `X-Api-Key`, el cuerpo del rango y el id codificado con `encodeURIComponent`.
- Cada respuesta da su `outcome`: `2xx` → `success`; `503` → `unavailable`; otro `5xx` o cuerpo que no es JSON → `server_error`; `401` → `unauthorized`; `404` → `not_found`; `400` y cualquier otro `4xx` → `bad_request`; sin respuesta → `timeout` al cumplirse `PORTAL_TIMEOUT_MS`; puerto cerrado → `connection_error`.
- Limitador: con límite N, el portal falso nunca recibe más de N peticiones en ninguna ventana.
- Pausa: tras un `429` con `Retry-After`, ninguna petición (de ningún alojamiento) llega antes de que pase; sin cabecera se usa el valor por defecto (invariante 4). Se registra `portal.rate_limited` con `retryAfter`.
- Adelantar el reloj controlado no acorta la ventana ni la pausa (son duraciones, no instantes).
- Las esperas del limitador y de la pausa se pueden interrumpir (lo necesitará la parada).

**CA**: ninguno propio; base de CA-4 y CA-5. La longitud de la ventana (60 s) y el `Retry-After` por defecto (60 s) son parámetros internos del cliente, no variables de entorno, para poder acortarlos en tests. El cliente solo implementa el `PUT`; nunca llama a `/__admin` (invariante 7).

---

## T5 — Persistencia y aplicación de un update

- [x] Hecha

**Objetivo**: guardar en `accommodations_sync` el estado deseado por día, aplicando cada update con concurrencia optimista por `rev`.

**Depende de**: T1, T2.

**Ficheros previstos**: `src/storage/mongo.ts` (conexión e índices), `src/storage/types.ts` (documento), `src/storage/repository.ts` (leer; escribir solo si `rev` no ha cambiado y, si cambió, releer y reaplicar), `src/sync/state.ts` (función pura que aplica un update al documento), `test/helpers/mongo.ts` (`mongodb-memory-server` versión 8, base limpia por test), `test/integration/apply-update.test.ts`.

**Tests** (integración con MongoDB real en memoria):
- El primer update crea el documento: `seq` 1, días con `version` 1 y pendientes, `pending: true`, `pendingSince` y `nextAttemptAt` = ahora, `attempts` 0, `status: pending`, `leaseUntil: null`.
- Un segundo update solapado sube `seq` y `rev`; solo los días cuyos valores cambian reciben la versión nueva; `pendingSince` no se mueve.
- Un update con los mismos valores sobre un alojamiento `synced` no lo deja pendiente.
- Un update con los mismos valores sobre un alojamiento en `error` lo devuelve igualmente a `pending` (`attempts` 0, `nextAttemptAt` = ahora), aunque ningún día cambie de versión.
- N updates simultáneos sobre el mismo alojamiento se aplican todos: `seq` = N y no se pierde ningún día.
- Existen los tres índices de la SPEC.
- Efecto sobre un alojamiento en reintento (documentos sembrados): en `error` vuelve a `pending` con `attempts` 0 y `nextAttemptAt` = ahora; esperando por `5xx`/`401` se adelanta a ahora; en `failing` no se adelanta; tras timeout o error de conexión queda en `max(ahora, lastError.at + margen)` (invariante 5).

**CA**: ninguno propio; base de CA-1, CA-5 y CA-8 y del invariante 1.

---

## T6 — `POST /updates` y errores del servicio

- [x] Hecha

**Objetivo**: aceptar updates por HTTP con todas las reglas de validación de la SPEC y responder `202` solo cuando el cambio está escrito en MongoDB.

**Depende de**: T2, T5.

**Ficheros previstos**: `src/updates/validation.ts` (pura), `src/updates/route.ts`, `src/errors.ts` (manejador de errores y forma `{ error: { code, message } }`), `src/app.ts` (mod), `src/index.ts` (mod: conecta a MongoDB), `test/helpers/service.ts` (arranca la app contra el MongoDB en memoria con reloj controlado), `test/unit/validation.test.ts`, `test/integration/post-updates.test.ts`.

**Tests**:
- Unitario: cada fila de la tabla de reglas devuelve su código (`INVALID_BODY`, `INVALID_DATE`, `DATE_IN_PAST`, `RANGE_TOO_LARGE`), con sus límites: `2026-02-30` → `INVALID_DATE`; `from` = hoy se acepta y ayer no; 32 y 365 días se aceptan y 366 no; campo de más, campo que falta, tipo incorrecto, id vacío, con espacios en los extremos o de 65 caracteres, precio negativo.
- Integración: un update válido devuelve `202` con `updateId`, `accommodationId`, `from`, `to` y `days`, y el documento ya está en MongoDB al recibir la respuesta (invariante 1).
- Integración: cada regla devuelve su `400` por HTTP, con fechas relativas a "hoy" (el 30 de febrero, el del año siguiente al "hoy" del reloj controlado).
- Integración: JSON mal formado o sin `Content-Type: application/json` → `400 INVALID_BODY`; ruta inexistente → `404 NOT_FOUND`; un fallo inesperado → `500 INTERNAL_ERROR` sin detalles internos.
- Integración: con MongoDB parado → `503 STORAGE_UNAVAILABLE` y ningún `202`. El tiempo de espera del driver se acorta en la propia `MONGO_URL` del test (`serverSelectionTimeoutMS`), sin variable nueva.

**CA**: CA-7 (unitario e integración, parte de reglas del POST). Logs: `update.accepted` (con `updateId` y contenido) y `update.rejected` (con su código).

---

## T7 — `GET /accommodations/:id/sync-status`

- [x] Hecha

**Objetivo**: exponer el estado de sincronización de un alojamiento leyendo su documento.

**Depende de**: T3, T6.

**Ficheros previstos**: `src/status/route.ts`, `src/app.ts` (mod), `test/integration/sync-status.test.ts`.

**Tests** (integración):
- Alojamiento del que nunca se recibió un update → `404 NOT_FOUND`.
- Tras un `POST`: `status: pending`, `pendingDays`, `pendingSince`, `nextAttemptAt` y `pendingRanges` agrupados como se enviarán.
- Todos los campos aparecen siempre. En `synced` (documento sembrado): `pendingSince`, `nextAttemptAt` y `lastError` son `null`, `pendingDays` es 0 y `pendingRanges` está vacío.
- En `error` (documento sembrado): `pendingRanges` sigue mostrando lo que falta, `nextAttemptAt` es `null` y `lastError` es visible.
- Los días pendientes anteriores a hoy no cuentan en `pendingDays` ni en `pendingRanges` (adelantando el reloj).
- Con MongoDB parado → `503 STORAGE_UNAVAILABLE`.

**CA**: ninguno propio; es el punto de observación de CA-8 y de casi todos los tests de integración siguientes.

---

## T8 — Worker: bucle, lease y confirmación

- [x] Hecha

**Objetivo**: enviar al portal los rangos pendientes de cada alojamiento, reservándolo con un lease, y marcar sincronizados solo los días confirmados con un `200`.

**Depende de**: T3, T4, T5, T7.

**Ficheros previstos**: `src/sync/worker.ts`, `src/storage/repository.ts` (mod: reservar, renovar y liberar lease; escritura del resultado con `rev`), `src/sync/state.ts` (mod: transición tras un `200`), `src/index.ts` (mod: arranca el worker), `test/helpers/service.ts` (mod: servicio completo con portal falso y tiempos cortos), `test/integration/worker-sync.test.ts`.

**Tests** (integración, servicio completo):
- **CA-1**: dos updates solapados sobre el mismo alojamiento; el último PUT que recibe el portal falso para cada día lleva los valores del último update y el alojamiento acaba en `synced`.
- **CA-2**: el portal falso retiene la respuesta de un PUT, llega un update sobre esos días y entonces responde `200`; el día no queda sincronizado y se reenvía con el valor nuevo (invariantes 2 y 3).
- **CA-7** (rangos enviados): un update de 90 días llega como exactamente tres PUT que cubren cada día una vez, ninguno de más de 31 días (invariante 6).
- Al quedar sin pendientes: `status: synced`, `pending: false`, `pendingSince` y `nextAttemptAt` a `null`, `attempts` 0, `lastSyncedAt` con la hora del `200`, lease liberado.
- Un día cuyos valores no cambian no se reenvía.
- Un alojamiento con lease activo no se coge; uno con lease caducado se retoma y se registra `worker.lease_expired`. El lease se renueva antes de cada PUT.
- Las escrituras de lease no tocan `rev`; las de estado lo suben.

**CA**: CA-1 (integración), CA-2, CA-7 (integración, parte de rangos). Logs: `sync.put.succeeded`, `worker.started`, `worker.stopped`, `worker.lease_expired`. El worker tiene `start`/`stop` con sueño interrumpible (`WORKER_IDLE_MS`). En esta tarea, cualquier respuesta distinta de `200` se trata como fallo reintentable genérico (`attempts` +1, backoff, liberar lease y pasar al siguiente); T9 y T10 lo sustituyen por el tratamiento de cada tipo.

---

## T9 — Worker: reintentos, timeouts y `429`

- [x] Hecha

**Objetivo**: tratar los fallos transitorios del portal según la tabla *Respuestas del portal*: backoff, estado `failing`, margen tras timeout y espera por `429` manteniendo el lease.

**Depende de**: T8.

**Ficheros previstos**: `src/sync/worker.ts` (mod), `src/sync/state.ts` (mod: transiciones por `5xx`/`401`, timeout y error de conexión), `src/storage/repository.ts` (mod), `test/integration/worker-retries.test.ts`.

**Tests** (integración):
- **CA-4**: tras un `429` con `Retry-After`, el portal falso no recibe ninguna petición antes de que pase; después la sincronización termina y `attempts` no ha cambiado.
- Un update que llega durante la pausa por `429` sale en el primer PUT tras ella: el worker espera turno antes de renovar el lease y releer el documento.
- **CA-5**: el portal falso no responde a un PUT; no llega nada de ese alojamiento antes del margen, aunque entre un update nuevo en medio; otro alojamiento sí se envía mientras tanto; pasado el margen se reenvía el estado actual.
- Un `503` seguido de un `200`: `attempts` pasa a 1 con `lastError` y `nextAttemptAt` visibles en `sync-status`, y vuelve a 0 con `lastError: null`.
- Al primer fallo el worker se detiene en ese alojamiento: los rangos ya confirmados quedan confirmados y los restantes no se envían en ese ciclo.
- Con `FAILING_THRESHOLD` fallos seguidos pasa a `failing` y `sync.accommodation.failing` se registra una sola vez; un update nuevo no adelanta el reintento; un `200` posterior lo devuelve a `synced`.
- Un `401` se reintenta como un `5xx`.
- Si un update adelanta el reintento mientras un PUT está en camino y ese PUT falla con `5xx`, manda el fallo: `nextAttemptAt` queda con el backoff y el adelanto se pierde.

**CA**: CA-4 (integración), CA-5. Logs: `sync.put.failed`, `sync.accommodation.failing`. El backoff y el margen se guardan como instantes (`nextAttemptAt`), no como timers.

---

## T10 — Worker: errores permanentes

- [ ] Hecha

**Objetivo**: llevar a `error` los alojamientos que el portal rechaza con `404` o `400`, sin más reintentos hasta un update nuevo y sin dejar un update atascado detrás del `error`.

**Depende de**: T9.

**Ficheros previstos**: `src/sync/worker.ts` (mod), `src/sync/state.ts` (mod: transición a `error` condicionada a que `seq` no haya subido), `test/integration/worker-errors.test.ts`.

**Tests** (integración):
- **CA-8**: un alojamiento que el portal falso responde con `404` se acepta con `202` y termina en `error`, con el `404` en `lastError` y `nextAttemptAt: null`; el portal falso no recibe más peticiones suyas; un update nuevo lo devuelve a `pending` y se vuelve a enviar.
- Si llega un update mientras se procesa el `404`, no se marca `error`: se reintenta de inmediato con el estado nuevo, y solo pasa a `error` si vuelve a fallar sin cambios de por medio.
- Un `400` y cualquier otro `4xx` se tratan igual que el `404`.

**CA**: CA-8. Log: `sync.accommodation.error`.

---

## T11 — Métricas

- [ ] Hecha

**Objetivo**: exponer `GET /metrics` en formato Prometheus con las cinco métricas de la SPEC y las del proceso Node.

**Depende de**: T10.

**Ficheros previstos**: `src/metrics/registry.ts` (registro y definición de métricas), `src/metrics/route.ts`, `src/portal/client.ts` (mod: contador e histograma por llamada), `src/sync/worker.ts` (mod: `sync_retries_total`), `src/storage/repository.ts` (mod: consultas con índice para los gauges), `src/app.ts` (mod), `test/integration/metrics.test.ts`.

**Tests** (integración):
- **CA-9**: tras un `503` y un `200`, `attempts` sube y vuelve a 0, y `/metrics` muestra `portal_requests_total` con `outcome="unavailable"` y `outcome="success"` y `sync_retries_total{reason="unavailable"}`.
- **CA-10**: con alojamientos pendientes, se para el servicio y se arranca otro sobre la misma base; la primera consulta a `/metrics` da `sync_accommodations_by_status` y `sync_oldest_pending_age_seconds` correctos.
- `sync_oldest_pending_age_seconds` cuenta `pending` y `failing`, excluye `error` y vale 0 si no hay ninguno.
- Un `429` cuenta en `portal_requests_total{outcome="rate_limited"}` y no en `sync_retries_total`.
- El histograma `portal_request_duration_seconds` tiene buckets hasta 15 s; ninguna métrica lleva la etiqueta `accommodationId`.
- Con MongoDB parado → `503 STORAGE_UNAVAILABLE`.

**CA**: CA-9, CA-10. Los gauges se calculan desde MongoDB en cada consulta; las latencias se miden con `performance.now()`.

---

## T12 — Arranque y barrido de días pasados

- [ ] Hecha

**Objetivo**: retomar el trabajo pendiente tras un reinicio y evitar que los días ya pasados dejen un alojamiento atascado.

**Depende de**: T11.

**Ficheros previstos**: `src/sync/sweep.ts`, `src/storage/repository.ts` (mod: reset de `leaseUntil` al arrancar, escritura del barrido con `rev`), `src/sync/state.ts` (mod: recalcular `pending` y `status` ignorando días pasados), `src/sync/worker.ts` (mod: barrido en cada cambio de día UTC), `src/index.ts` (mod: reset de leases y barrido antes de arrancar el worker), `test/integration/restart-and-sweep.test.ts`.

**Tests** (integración):
- **CA-6**: con updates pendientes en varios alojamientos, uno de ellos con un lease vivo de un proceso "muerto", se arranca un servicio nuevo sobre la misma base y todos acaban en `synced`.
- **CA-11**: un alojamiento en `error` cuyos días pendientes ya han pasado (adelantando el reloj más de un día) queda en `synced` tras el barrido y deja de contar en `sync_accommodations_by_status{status="error"}`.
- El barrido se ejecuta al arrancar y también al cambiar de día UTC con el servicio en marcha.
- Un alojamiento con días pendientes pasados y futuros sigue `pending` y solo se envían los futuros.
- Los días pasados no se borran del documento.

**CA**: CA-6, CA-11. Log: `sweep.completed` (info, con los alojamientos revisados y los que pasan a `synced`). La SPEC no nombra este evento: sigue el patrón `area.accion` y se lista al terminar para añadirlo a la SPEC.

---

## T13 — Parada ordenada y MongoDB caído

- [ ] Hecha

**Objetivo**: cerrar el servicio sin dejar trabajo a medias ni leases colgados, y hacer que el worker sobreviva a una caída de MongoDB.

**Depende de**: T12.

**Ficheros previstos**: `src/lifecycle.ts` (parada: señales, orden de cierre y tiempo máximo), `src/index.ts` (mod), `src/sync/worker.ts` (mod), `src/portal/client.ts` (mod, si hace falta para interrumpir esperas), `test/integration/shutdown.test.ts`, `test/integration/storage-down.test.ts`.

**Tests** (integración):
- Parada con un PUT en curso: se espera a esa petición, el lease queda liberado (`leaseUntil: null`) y el servicio cierra dentro de `SHUTDOWN_TIMEOUT_MS`.
- Parada durante una espera (bucle, limitador o pausa por `429`): la espera se interrumpe y no se envía nada más.
- Si el portal no responde, la parada no espera más que el timeout de la petición.
- MongoDB se para y vuelve: el worker registra el error, duerme `WORKER_IDLE_MS` y termina de sincronizar lo pendiente; el proceso no muere.

**CA**: ninguno propio; cubre los apartados *Parada* y *MongoDB caído* de la SPEC. El evento de log del fallo de almacenamiento no tiene nombre en la SPEC: sigue el patrón `area.accion` (`worker.storage_error`) y se lista al terminar.

---

## T14 — E2E contra Portal Sol y cierre

- [ ] Hecha

**Objetivo**: comprobar el servicio completo contra el Portal Sol real, provocando `429`, y dejar la documentación de `service/` al día.

**Depende de**: T13.

**Ficheros previstos**: `test/e2e/sync.e2e.test.ts`, `vitest.e2e.config.ts` (mod: tiempos máximos largos), `test/helpers/service.ts` (mod: logger a un stream capturado), `README.md` de `service/` (mod: sección *Estructura*).

**Tests** (E2E, `npm run test:e2e` con `docker compose --profile mongo up -d`; siguen los cinco pasos de la SPEC). El test arranca el servicio en su propio proceso, contra el MongoDB del compose, con el logger escribiendo en un stream capturado:
1. `POST /__admin/reset` y base de datos del servicio limpia.
2. Servicio arrancado con `PORTAL_RATE_LIMIT` por encima del límite del portal; ráfaga de updates solapados sobre varios alojamientos, uno de más de 31 días.
3. Espera por condición hasta que todos estén en `synced`.
4. **CA-1** y **CA-3**: `GET /api/v1/accommodations/:id` devuelve en el portal los valores del último update de cada día.
5. **CA-3** y **CA-4**: en `/__admin/requests` no hay ningún PUT de más de 31 días y el update de 90 días son tres PUT. `/__admin/requests` no guarda el `Retry-After`, así que se toma de los eventos `portal.rate_limited` capturados: cada `PUT` con `429` se empareja en orden con su evento, y entre ese `429` y el fin de su `retryAfter` no hay ningún `PUT`.

**CA**: CA-1 (E2E), CA-3 (E2E), CA-4 (E2E). Las fechas son relativas al "hoy" real. Solo el test llama a `/__admin`; sus `GET` al portal gastan del mismo contador y también pueden recibir `429`, pero no generan eventos `portal.rate_limited` ni son `PUT`.

---

## Cobertura de criterios de aceptación

| CA | Unitario | Integración | E2E |
|---|---|---|---|
| CA-1 | — | T8 | T14 |
| CA-2 | — | T8 | — |
| CA-3 | T3 | — | T14 |
| CA-4 | — | T9 | T14 |
| CA-5 | — | T9 | — |
| CA-6 | — | T12 | — |
| CA-7 | T2 (fechas), T3 (rangos), T6 (reglas) | T6 (reglas), T8 (rangos enviados) | — |
| CA-8 | — | T10 | — |
| CA-9 | — | T11 | — |
| CA-10 | — | T11 | — |
| CA-11 | — | T12 | — |
