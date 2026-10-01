# SPEC — Servicio de sincronización de disponibilidad

## Objetivo

Servicio que recibe cambios de disponibilidad y precio de alojamientos por HTTP, los persiste y los sincroniza con Portal Sol respetando sus límites. Ningún cambio aceptado se pierde (ni por fallos del portal ni por reinicios) y el estado final del portal refleja lo último que pidió el gestor. Expone el estado de sincronización por alojamiento, logs estructurados y métricas.

## Contexto y supuestos

- **Stack**: Node.js 24, TypeScript, Fastify, MongoDB (driver oficial), `fetch` nativo, `prom-client`, `vitest`, ESLint.
- **Una sola instancia.** Con varias, el reparto de trabajo seguiría funcionando (vive en MongoDB), pero no el límite de peticiones (vive en memoria).
- **Fechas**: días de calendario `YYYY-MM-DD`, rangos inclusivos (como el portal). Toda la aritmética y el "hoy" en UTC, que no tiene cambios de hora; el portal no define zona horaria.
- **Reloj**: la hora actual se obtiene siempre de un único módulo `now()`. El reloj decide sobre instantes guardados (`hoy`, `nextAttemptAt`, `leaseUntil`, `pendingSince`); las duraciones (sueño del bucle, esperas del limitador y de la pausa) usan timers reales, configurables y muy cortos en tests. El backoff y el margen tras timeout no son duraciones sino instantes: se guardan como `nextAttemptAt = now() + …` y se comparan con `now()`. En tests el reloj no se congela: se le aplica un desplazamiento sobre la hora real, para poder "saltar" hacia delante. Sin fake timers (no conviven bien con MongoDB ni con HTTP real).
- **Portal, medido antes de escribir esta SPEC** (API.md no lo documenta): acepta fechas fuera de sus 90 días iniciales; límite de 30 peticiones por ventana de 60 s desde la primera petición, compartido por GET y PUT y contando los `503`; ~18 % de `503` aleatorios; latencia mediana ~0,5 s y un 5 % de peticiones de ~10 s que terminan; una petición abandonada por timeout se aplica igualmente.

## API del servicio

### `POST /updates`

```json
{ "accommodationId": "acc-1003", "from": "2026-10-01", "to": "2026-10-07", "available": true, "pricePerNight": 120.00 }
```

| Regla (todas `400`) | Código |
|---|---|
| Campos obligatorios, con su tipo, sin extras. No hay cambios parciales: el portal exige ambos valores en cada PUT | `INVALID_BODY` |
| `accommodationId`: cadena no vacía sin espacios en los extremos, máximo 64 caracteres (se codifica con `encodeURIComponent` en la URL del portal) | `INVALID_BODY` |
| `pricePerNight >= 0` | `INVALID_BODY` |
| `from` y `to` son fechas reales: se parsean y reformatean, y si no coincide con el texto se rechazan (nunca un 30 de febrero) | `INVALID_DATE` |
| `to >= from` | `INVALID_DATE` |
| `from` no es anterior a hoy | `DATE_IN_PAST` |
| Máximo 365 días. Más de 31 se admite (el límite es del portal, no del negocio) y se trocea al enviar | `RANGE_TOO_LARGE` |

- No se comprueba si el alojamiento existe en el portal: haría depender la aceptación de que el portal esté disponible y gastaría cuota. Si no existe, acabará en `error`.
- Un día cuyos valores coinciden con los guardados no cambia de versión ni se reenvía: la cuota es escasa.
- Efecto sobre un alojamiento en reintento: en `error`, vuelve a `pending` (`attempts = 0`, `nextAttemptAt = ahora`) aunque el update no cambie ningún valor, porque es la única forma de pedir un nuevo intento; en los demás estados, un update que no cambia ningún valor no adelanta el reintento, porque no hay nada nuevo que enviar; en `failing` no se toca `nextAttemptAt`, sea cual sea el último fallo, para no gastar cuota con el portal caído; esperando por `5xx`/`401`, se adelanta el reintento (`nextAttemptAt = ahora`); tras un timeout o error de conexión, `nextAttemptAt = max(ahora, lastError.at + margen)` (invariante 5). Si el update adelanta el reintento mientras un PUT está en camino y ese PUT falla, manda el fallo: se aplica su backoff y el adelanto se pierde, porque el fallo es información más nueva sobre el portal.

Respuesta `202`, solo cuando el cambio está escrito en MongoDB:

```json
{ "updateId": "…", "accommodationId": "acc-1003", "from": "2026-10-01", "to": "2026-10-07", "days": 7 }
```

### `GET /accommodations/:id/sync-status`

Para que quien esté de guardia, o el gestor, sepa si los cambios han llegado al portal y, si no, por qué.

```json
{
  "accommodationId": "acc-1003",
  "status": "pending",
  "pendingDays": 2,
  "pendingSince": "2026-10-01T10:15:00.000Z",
  "pendingRanges": [
    { "from": "2026-10-03", "to": "2026-10-03", "available": true,  "pricePerNight": 150 },
    { "from": "2026-10-04", "to": "2026-10-04", "available": false, "pricePerNight": 120 }
  ],
  "attempts": 1,
  "nextAttemptAt": "2026-10-01T10:16:30.000Z",
  "lastError": { "code": "TIMEOUT", "message": "Sin respuesta tras 15 s", "at": "2026-10-01T10:15:30.000Z" },
  "lastSyncedAt": "2026-10-01T10:14:02.000Z"
}
```

`pendingRanges` es lo que falta por llegar, agrupado como se enviará (también en `error`). Todos los campos aparecen siempre: en `synced`, `pendingSince`, `nextAttemptAt` y `lastError` son `null`, `pendingDays` es 0 y `pendingRanges` está vacío. `lastSyncedAt` es la hora del último `200`.

| `status` | Significado |
|---|---|
| `synced` | Sin días pendientes. |
| `pending` | Días pendientes enviándose o esperando reintento (incluye pausas por `429` o timeout). |
| `failing` | Días pendientes con 5 o más fallos seguidos. Se sigue reintentando. |
| `error` | Error permanente (`404` o `400` del portal). `nextAttemptAt` es `null`: el worker no lo coge hasta que llegue un nuevo update. |

Si nunca se ha recibido un update de ese alojamiento: `404 NOT_FOUND`.

### Errores del servicio

Misma forma que el portal, `{ "error": { "code": "...", "message": "..." } }`, con un manejador de errores propio en Fastify:

| Caso | Respuesta |
|---|---|
| JSON mal formado, sin `Content-Type: application/json` o de más de 1 MB | `400 INVALID_BODY` (traduciendo los errores de parseo de Fastify) |
| Ruta inexistente o URL mal codificada (por ejemplo, `/%zz`) | `404 NOT_FOUND` |
| MongoDB no disponible (en `POST`, `sync-status` o `/metrics`) | `503 STORAGE_UNAVAILABLE`; en el `POST`, sin `202` (invariante 1) |
| Cualquier otro fallo | `500 INTERNAL_ERROR`, sin detalles internos |

## Modelo de datos

Se guarda el **estado deseado por día**, no una cola de updates: con una cola, el reintento de un update antiguo podría pisar uno más nuevo; con el estado, siempre se envía lo último que pidió el gestor y los cambios sobre las mismas fechas se agrupan en menos peticiones.

Una única colección, `accommodations_sync`, un documento por alojamiento. Es la fuente de verdad: de ella leen el worker, `sync-status` y las métricas.

```json
{
  "_id": "acc-1003",
  "seq": 3,
  "rev": 7,
  "days": {
    "2026-10-01": { "available": true,  "price": 120, "version": 1, "syncedVersion": 1 },
    "2026-10-03": { "available": true,  "price": 150, "version": 3, "syncedVersion": 1 },
    "2026-10-04": { "available": false, "price": 120, "version": 2, "syncedVersion": 1 }
  },
  "pending": true,
  "pendingSince": "2026-10-01T10:15:00.000Z",
  "nextAttemptAt": "2026-10-01T10:16:30.000Z",
  "attempts": 1,
  "leaseUntil": null,
  "status": "pending",
  "lastError": { "code": "TIMEOUT", "message": "…", "at": "2026-10-01T10:15:30.000Z" },
  "lastSyncedAt": "2026-10-01T10:14:02.000Z"
}
```

| Campo | Significado |
|---|---|
| `days` | Días sueltos, no rangos (los rangos obligarían a partirlos y fusionarlos en cada solape). Los rangos solo se calculan al enviar. |
| `seq` | Sube con cada update aceptado y nunca se reinicia: si volviera a empezar, un cambio nuevo tendría una versión menor que uno ya entregado y no se enviaría. |
| `rev` | Sube con **cada** escritura, del `POST` o del worker. Es la condición de la concurrencia optimista. |
| `version` | `seq` del último update que cambió ese día. |
| `syncedVersion` | Última versión del día confirmada con un `200`. Pendiente si `version > syncedVersion`. |
| `pending` | Hay algún día pendiente con fecha de hoy o posterior; permite al worker encontrarlo con índice. |
| `pendingSince` | Cuándo pasó de "al día" a "con pendientes". `null` al quedar sincronizado. |
| `attempts` | Fallos seguidos; 0 con cada PUT correcto. |
| `nextAttemptAt` | Cuándo puede el worker volver a cogerlo; `null` en `error`. |
| `leaseUntil` | Reserva del worker; si el proceso muere, caduca y otro ciclo lo retoma. |
| `status` | `synced` / `pending` / `failing` / `error`, almacenado para que `sync-status` y métricas lo lean directamente. |
| `lastError` | Último fallo del portal; se borra con el siguiente `200`. |

Índices: `{ pending: 1, nextAttemptAt: 1 }` (worker), `{ status: 1 }` y `{ pending: 1, pendingSince: 1 }` (métricas).

**Concurrencia optimista en las escrituras de estado.** `POST`, worker y barrido leen el documento y escriben, subiendo `rev`, solo si `rev` sigue siendo el leído; si no, releen y reaplican su cambio sobre el estado nuevo. Las escrituras que solo tocan `leaseUntil` (reservar, renovar, liberar y el reset al arrancar) son operaciones atómicas con su propio filtro: ni comprueban ni suben `rev`. (`seq` no sirve como condición: el worker no lo sube, y un `POST` podría pisar lo que el worker acaba de escribir.) El `POST` escribe `seq`, `days`, `pending`, `pendingSince` y, cuando corresponde, `attempts`, `nextAttemptAt` y `status`; el worker, el resto. Así, dos updates simultáneos no se pisan entre sí, y un update tampoco pisa lo que el worker acaba de escribir.

No hay colección de updates: el log `update.accepted` deja constancia de cada uno con su `updateId` y contenido.

## Sincronización

### Worker

Bucle en el mismo proceso que el servidor HTTP:

1. Reserva atómicamente (`findOneAndUpdate`) un alojamiento con `pending: true`, `nextAttemptAt <= ahora` y sin lease activo, fijando `leaseUntil = ahora + 2 min`. Renueva el lease antes de cada PUT: muchos rangos con timeouts y esperas pueden superar los 2 minutos. Si al renovarlo resulta que se ha perdido, el resultado del PUT ya recibido se escribe igualmente y el worker deja ese alojamiento: con una sola instancia y la condición de `rev` es seguro.
2. Envía sus rangos uno a uno. **Al primer fallo se detiene**: actualiza `attempts` y `nextAttemptAt`, libera el lease y pasa al siguiente; los rangos ya confirmados quedan confirmados. Repite sin esperar; si no hay nada, duerme 1 s.

Antes de cada PUT, el orden es: esperar turno (limitador y pausa por `429`), renovar el lease, releer el documento y enviar. La espera va primero para que el lease cubra el PUT aunque la espera haya sido larga, y para que se envíe el estado deseado del momento de enviar, no el leído antes de esperar (invariante 3). Por eso el cliente separa "esperar turno", que no ocupa hueco en la ventana, de "enviar", que vuelve a comprobar el limitador y la pausa.

El ritmo lo marca el limitador, no el bucle. Un `429` a mitad de un alojamiento se espera manteniendo el lease: la pausa es global y soltarlo no ayudaría.

**Barrido de días pasados**: al arrancar y en cada cambio de día UTC, para cada alojamiento con `pending: true` se recalculan `pending` y `status` ignorando los días anteriores a hoy. Si no queda ningún día pendiente de hoy o posterior, pasa a `synced`, también desde `error`. Como cualquier paso a `synced`, llegue como llegue, deja `attempts` a 0 y `lastError`, `pendingSince` y `nextAttemptAt` a `null`, aunque no haya habido un `200`; el historial de fallos queda en los logs. Sin esto, un alojamiento atascado con días ya pasados mantendría las alertas encendidas para siempre. Entre el cambio de día y el barrido, `sync-status` puede mostrar el `status` guardado con `pendingDays: 0` y `pendingRanges` vacío: es un estado transitorio aceptable que corrige el barrido. Los días pasados **no se borran** del documento: el tamaño no es problema (más de 100.000 días por documento) y la agrupación y `sync-status` ya los ignoran.

**Arranque**: el servicio pone `leaseUntil: null` en todos los documentos; con una sola instancia, cualquier lease existente es de un proceso muerto. Después ejecuta el barrido.

**Parada**: se interrumpen las esperas (bucle, limitador, pausa), se espera solo a la petición HTTP en curso (como máximo el timeout), se libera el lease y se cierra; tiempo máximo 20 s. Si MongoDB falla al parar, el lease puede quedar sin liberar; el siguiente arranque lo limpia.

**MongoDB caído**: si una operación del bucle falla con un error de MongoDB, el worker lo registra (`worker.storage_error`) y duerme `WORKER_IDLE_MS`; no muere. Si lo que no se pudo guardar es el resultado de un PUT, el lease no se libera: el alojamiento se retoma cuando caduca, nunca antes, para no saltarse el margen tras un timeout (invariante 5). Limitación conocida: tras una caída, ese alojamiento espera hasta `LEASE_MS` y se retoma con `worker.lease_expired` aunque el envío no tardara. Los errores que no son de MongoDB (un bug) no se capturan y terminan el proceso, a propósito.

### Agrupación en rangos

Se recorren los días pendientes de hoy o posteriores en orden y se abre un grupo nuevo si hay un hueco, si cambian los valores o si el grupo ya tiene 31 días. Cada grupo es un `PUT` con el estado actual de esos días. Ejemplo: 90 días iguales desde el 1 de octubre dan 1–31 oct, 1 nov–1 dic y 2–29 dic.

Tras un `200`, `syncedVersion = version` solo en los días cuya versión no cambió mientras el PUT estaba en camino; los demás siguen pendientes. Si llegó un update (subió `seq`) mientras se procesaba un `404` o `400`, no se marca `error`: se programa un intento inmediato con el estado nuevo, y solo si vuelve a fallar sin cambios de por medio pasa a `error`. Así un update nunca queda atascado detrás de un `error` escrito a la vez. Ese intento inmediato se programa una vez aunque el alojamiento esté en `failing` (sin tocar `attempts` ni `status`): la regla de no adelantar en `failing` es para no gastar cuota con el portal caído (`5xx`), y esta, para no dejar un update atascado tras un `error`.

### Respuestas del portal

| Respuesta | `attempts` | Siguiente intento | Estado |
|---|---|---|---|
| `200` | 0 | Inmediato si quedan pendientes | `synced` o `pending` |
| `5xx` o `401` | +1 | Backoff `min(2 s × 2^(attempts−1), 5 min)` con *full jitter* | `pending` o `failing` (5 o más fallos) |
| Timeout o error de conexión | +1 | `max(margen de espera, backoff)`, con el backoff ya con jitter (no su tope) | `pending` o `failing` |
| `429` | Sin cambios | Pausa global hasta `Retry-After` | Sin cambios |
| `404` o `400` | Sin cambios | `nextAttemptAt = null` (`400` indica un bug: validamos igual que el portal) | `error` |

Un `401` solo ocurre con la API key mal configurada; se reintenta como un error más y lo harán visible la alerta de cambios sin sincronizar y los logs. Respuestas no previstas: cualquier `2xx` es éxito; cualquier otro `4xx` se trata como `400` (`outcome=bad_request`); todo lo demás, como `server_error`. Un cuerpo vacío o que no es JSON da `server_error` sea cual sea el código, salvo en un `429`, que siempre activa la pausa: el portal responde siempre JSON, así que un `2xx` sin cuerpo o una página HTML (de un proxy o de una `PORTAL_URL` mal puesta, incluido un `503` o un `404`) no viene de él. No se marca ningún día como sincronizado ni se deja el alojamiento en `error`: se reintenta.

### Límite de peticiones

Todas las llamadas pasan por un único cliente con un limitador de **ventana deslizante**: solo envía si en los últimos 60 s se han enviado menos de 25 (configurable). Es más estricto que la ventana del portal, así que es seguro, y deja margen respecto a su límite de 30 para diferencias de reloj y para los GET de los tests E2E, que gastan del mismo contador. Pausa global tras un `429`: nada se envía hasta que pase `Retry-After`, en segundos o como fecha HTTP en formato IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`). La fecha se compara con `now()` al recibirla y, si ya ha pasado, no hay pausa. Si falta la cabecera o no se puede interpretar (incluidos los formatos de fecha obsoletos RFC 850 y asctime), 60 s. La pausa vive en memoria; tras un reinicio, el siguiente `429` la restablece a costa de una petición.

### Timeouts

Timeout por petición: 15 s, por encima de las respuestas lentas medidas (~10 s), para que terminen en lugar de cortarse.

Una petición que expira en nuestro lado puede aplicarse igual en el portal y pisar un PUT posterior. Por eso, tras un timeout, no se envía nada de ese alojamiento durante un margen configurable (30 s, tres veces la latencia máxima medida) y después se reenvía el estado actual; reenviar es seguro porque el PUT es idempotente. Riesgo residual: si el portal procesa la petición vieja después del margen, puede pisar el reenvío; evitarlo requeriría escrituras condicionales en el portal, que su API no ofrece.

## Configuración

Variables de entorno. Los valores por defecto sirven para el `docker-compose` local; los tests usan tiempos mucho más cortos. Si una variable tiene un valor inválido (por ejemplo, `PORT=abc`), el servicio no arranca y el error nombra la variable; se escribe en texto plano por `stderr`, porque el logger no existe antes de leer la configuración. Lo mismo si MongoDB no está disponible al arrancar: el servicio no arranca y lo dice por `stderr`, en texto plano.

| Variable | Por defecto | Qué controla |
|---|---|---|
| `PORT` | `3000` | Puerto del servicio |
| `MONGO_URL` | `mongodb://localhost:27017/sync` | Conexión a MongoDB |
| `PORTAL_URL` | `http://localhost:4000` | URL base de Portal Sol |
| `PORTAL_API_KEY` | `sol-demo-key` | Cabecera `X-Api-Key` |
| `PORTAL_RATE_LIMIT` | `25` | Peticiones máximas en cualquier ventana de 60 s |
| `PORTAL_TIMEOUT_MS` | `15000` | Timeout por petición |
| `TIMEOUT_GRACE_MS` | `30000` | Margen tras timeout o error de conexión |
| `BACKOFF_BASE_MS` / `BACKOFF_MAX_MS` | `2000` / `300000` | Backoff |
| `FAILING_THRESHOLD` | `5` | Fallos seguidos para `failing` |
| `LEASE_MS` | `120000` | Duración del lease. Debe ser mayor que `PORTAL_TIMEOUT_MS + TIMEOUT_GRACE_MS` (con los valores por defecto se cumple: 120 s frente a 45 s), para que el lease que no se libera al no poder guardar el resultado de un PUT cubra el margen tras timeout (invariante 5). No se comprueba en código |
| `WORKER_IDLE_MS` | `1000` | Sueño del worker sin trabajo |
| `SHUTDOWN_TIMEOUT_MS` | `20000` | Tiempo máximo de parada |
| `LOG_LEVEL` | `info` | Nivel de log |

## Invariantes

1. Un `202` solo se devuelve cuando el cambio está escrito en MongoDB.
2. Un día solo se marca sincronizado tras un `200` del portal para la versión enviada.
3. Nunca se envía un valor que no sea el estado actual deseado de un día.
4. Nunca se envía una petición durante una pausa por `429`.
5. Tras un timeout, nada de ese alojamiento se envía antes del margen de espera.
6. Nunca se envía un rango de más de 31 días ni una fecha inexistente.
7. El servicio no usa los endpoints `/__admin` del portal; solo los tests.

## Observabilidad

Las **métricas** dicen si la sincronización está sana y son la base de las alertas; los **logs** explican qué le pasó a un update o alojamiento; `sync-status` da el detalle de uno.

### Logs

JSON por salida estándar con `pino`, nivel configurable. Cada línea lleva `event` (nombre estable para filtrar) y, según el caso, `accommodationId`, `updateId`, `from`, `to`, `attempt`, `status` (HTTP del portal), `errorCode`, `durationMs`, `nextAttemptAt` y el `reqId` de Fastify.

| `event` | Nivel | Cuándo |
|---|---|---|
| `update.accepted` | info | Update guardado (`202`), con `updateId` y contenido |
| `update.rejected` | info | Validación fallida (`400`), con su código |
| `sync.put.succeeded` | info | PUT con `200` |
| `sync.put.failed` | warn | PUT con `5xx`, `401`, timeout o error de conexión |
| `portal.rate_limited` | warn | `429`, con `retryAfter`: la pausa aplicada, en segundos como la cabecera (con decimales si viene de una fecha HTTP) |
| `sync.accommodation.failing` | error | Cruza el umbral de fallos (una vez, no en cada intento) |
| `sync.accommodation.error` | error | Error permanente (`404` o `400`) |
| `worker.lease_expired` | warn | Se retoma un alojamiento cuyo lease caducó con el proceso vivo (tardó más de 2 min, o MongoDB cayó al guardar el resultado de un PUT) |
| `worker.storage_error` | error | Una operación del bucle falla con un error de MongoDB; el worker duerme `WORKER_IDLE_MS` y sigue |
| `worker.started` / `worker.stopped` | info | Arranque y parada del worker |
| `sweep.completed` | info | Barrido de días pasados terminado, con los alojamientos revisados (`reviewed`) y los que pasan a `synced` (`settled`) |
| `server.started` | info | Servidor HTTP escuchando, con el puerto |
| `server.shutdown_failed` | error | La parada falla o supera `SHUTDOWN_TIMEOUT_MS`; el proceso sale con código 1 |
| `http.request` | info | Una por petición al servicio (desde un hook `onResponse`), con `reqId`, método, ruta, código y `durationMs`. Los logs de petición propios de Fastify se desactivan |
| `http.storage_unavailable` | error | MongoDB no disponible al atender una petición (`503 STORAGE_UNAVAILABLE`), con el error |
| `http.internal_error` | error | Fallo inesperado al atender una petición (`500 INTERNAL_ERROR`), con el error; la respuesta no lleva detalles internos |

### Métricas

`GET /metrics` en formato Prometheus (`prom-client`), más las del proceso Node. Sin etiqueta `accommodationId` (con miles de alojamientos generaría miles de series); el detalle está en `sync-status` y logs. Las de trabajo pendiente se calculan desde MongoDB en cada consulta (consultas con índice), para que sean correctas tras un reinicio. No hay métrica de días pendientes: exigiría recorrer todos los documentos.

| Métrica | Tipo | Cubre |
|---|---|---|
| `sync_accommodations_by_status{status}` | gauge | Trabajo pendiente: alojamientos por estado |
| `sync_oldest_pending_age_seconds` | gauge | Trabajo pendiente: antigüedad del `pendingSince` más viejo entre `pending` y `failing` (0 si no hay). Excluye `error`, que tiene su propia alerta; si no, un id inexistente dejaría la crítica encendida hasta un año |
| `portal_requests_total{method, outcome}` | counter | Resultado de las llamadas al portal |
| `portal_request_duration_seconds{method, outcome}` | histogram | Latencia (buckets hasta 15 s) |
| `sync_retries_total{reason}` | counter | Reintentos programados por un fallo reintentable, uno por fallo: `unavailable`, `server_error`, `timeout`, `connection_error`, `unauthorized`. No cuentan la espera por `429` ni el intento inmediato tras un `404`/`400` con un update nuevo de por medio |

`outcome`: `success`, `rate_limited`, `unavailable`, `server_error`, `timeout`, `connection_error`, `not_found`, `bad_request`, `unauthorized`.

### Alertas propuestas

La única alerta crítica es la que indica que los gestores están afectados; las que señalan causas son avisos. Los umbrales son iniciales.

| Alerta | Severidad | Condición (PromQL) | Significado |
|---|---|---|---|
| Cambios sin sincronizar | crítica | `sync_oldest_pending_age_seconds > 900` durante 5 min | Cambios con más de 15 min sin llegar al portal |
| Alojamientos fallando | aviso | `sync_accommodations_by_status{status="failing"} > 0` durante 10 min | 5 o más fallos seguidos |
| Alojamientos en error | aviso | `sync_accommodations_by_status{status="error"} > 0` | Requiere una persona: alojamiento inexistente o bug |
| Portal con errores | aviso | `sum(rate(portal_requests_total{outcome=~"unavailable|server_error|timeout|connection_error"}[5m])) / sum(rate(portal_requests_total[5m])) > 0.2` durante 10 min | Más del 20 % de llamadas fallan |
| `429` frecuentes | aviso | `increase(portal_requests_total{outcome="rate_limited"}[15m]) > 3` | Limitador mal calibrado |

## Criterios de aceptación

| # | Criterio | Test |
|---|---|---|
| CA-1 | Con dos updates solapados sobre el mismo alojamiento, el portal acaba con los valores del último. | Integración, E2E |
| CA-2 | Si llega un update mientras un PUT de esos días está en camino, el día no se marca sincronizado y se reenvía con el valor nuevo. | Integración |
| CA-3 | Un update de 90 días genera exactamente tres PUT, ninguno de más de 31 días. | Unitario, E2E |
| CA-4 | Tras un `429`, no llega ninguna petición del servicio al portal antes del `Retry-After`. Las del propio test E2E gastan del mismo contador y pueden caer dentro de una pausa. | Integración, E2E |
| CA-5 | Tras un timeout, nada de ese alojamiento se envía antes del margen; después se reenvía el estado actual. | Integración |
| CA-6 | Tras un reinicio con updates pendientes, todos se sincronizan. | Integración |
| CA-7 | `2026-02-30` se rechaza con `400 INVALID_DATE`, cada regla del POST devuelve su código, y ningún rango enviado repite ni salta días. | Unitario, integración |
| CA-8 | Un alojamiento inexistente se acepta y termina en `error`, con el `404` visible en `sync-status` y sin más reintentos; un update nuevo lo devuelve a `pending`. | Integración |
| CA-9 | Tras un `503` y un `200`, `attempts` sube y vuelve a 0, y `/metrics` refleja la llamada fallida y el reintento. | Integración |
| CA-10 | Tras un reinicio con pendientes, `sync_accommodations_by_status` y `sync_oldest_pending_age_seconds` son correctos desde la primera consulta. | Integración |
| CA-11 | Un alojamiento en `error` cuyos días pendientes ya han pasado queda en `synced` tras el barrido, y deja de contar en las métricas. | Integración |

## Tests

Con `vitest`, en tres niveles.

**Unitarios** (funciones puras): fechas (`2026-02-30` y `2026-02-29` se rechazan, `2028-02-29` se acepta; rangos que cruzan fin de mes y el cambio de hora del 25 de octubre de 2026 no repiten ni saltan días); agrupación (huecos, cambios de valores; 31, 32 y 90 días dan 1, 2 y 3 grupos exactos); backoff (crece y nunca supera el tope).

**Integración** (CA-1, CA-2 y CA-4 a CA-11): servicio completo contra un MongoDB real con `mongodb-memory-server` (versión 8, la del compose) y un **portal falso**: un servidor HTTP que arranca el test, responde lo que este le indica (`200`, `429` con `Retry-After`, `503`, `404` o no responder) y registra cada petición con su hora. El portal real falla y tarda al azar, así que no permite tests reproducibles. Los tiempos se configuran muy cortos y las fechas se generan relativas a "hoy" (reloj controlado), nunca fijas. `npm test` no necesita Docker; la primera ejecución descarga el binario de MongoDB.

**E2E** (`npm run test:e2e`, con el compose levantado; aparte por lento y aleatorio). Contra el Portal Sol real, con el limitador **por encima** del límite del portal para provocar `429` y comprobar que se respetan:

1. `POST /__admin/reset`.
2. Ráfaga de updates solapados sobre varios alojamientos, incluido uno de más de 31 días.
3. Esperar a que todos estén en `synced`.
4. Comprobar con `GET /api/v1/accommodations/:id` que el portal tiene el estado esperado (CA-1, CA-3).
5. Revisar `/__admin/requests`: ningún PUT de más de 31 días ni peticiones del servicio dentro de un `Retry-After` (CA-3, CA-4).
