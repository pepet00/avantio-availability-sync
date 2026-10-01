# Instrucciones para agentes

Servicio que sincroniza disponibilidad y precios con Portal Sol. El código vive en `service/`.

## Fuente de verdad

@SPEC.md

- La SPEC manda. Si una tarea pide algo que la SPEC no cubre o que la contradice, para y pregunta en lugar de improvisar.
- No amplíes el alcance: implementa lo que pide la tarea y nada más. Si ves algo que falta, dilo al terminar.
- No modifiques `SPEC.md` ni `PROCESS.md` salvo que te lo pida.

## Tareas

- Las tareas están en `TASKS.md`, numeradas (T1, T2...). Trabaja solo en la que te indique.
- Antes de escribir código, resume en 3-5 líneas qué vas a hacer y qué ficheros tocarás.
- No añadas dependencias sin preguntar. Las previstas: `fastify`, `mongodb` (driver oficial, sin Mongoose), `prom-client`, `typescript`, `@types/node`, `tsx` (para `npm run dev`), `vitest`, `mongodb-memory-server`, `eslint`, `typescript-eslint`. Para logs se reutiliza el logger `pino` de Fastify; no se instala aparte.

## Definición de "hecho"

Una tarea solo está terminada cuando, desde `service/`:

1. `npm run lint` y `npm run typecheck` pasan sin errores.
2. `npm test` pasa entero, no solo los tests nuevos.
3. Están implementados los tests que la SPEC y `TASKS.md` asignan a esa tarea (criterios CA-n y tests unitarios).
4. La revisión con `/revisar-tarea` da OK (ver abajo).

No desactives, borres ni debilites tests para que pasen.

## Revisión

Al cumplir los puntos 1-3, invoca la skill `/revisar-tarea` con el identificador de la tarea (por ejemplo, `/revisar-tarea T3`).

- La revisión la hace un subagente de solo lectura (`.claude/agents/revisor.md`): no corrige nada, solo informa. Las correcciones las haces tú.
- Si el veredicto es CAMBIOS NECESARIOS, corrige los problemas bloqueantes y vuelve a invocarla.
- Máximo dos rondas de corrección. Si tras la segunda sigue habiendo bloqueantes, para y explícame qué queda y por qué.
- Cuando dé OK, muéstrame el veredicto, las mejoras no bloqueantes y las dudas sobre la SPEC, y espera.

## Commits

- Haz commit solo cuando te lo pida. Nunca hagas `push` sin una orden explícita.
- Un commit por tarea, con [Conventional Commits](https://www.conventionalcommits.org) en español y el identificador de la tarea: `feat(worker): reintentos con backoff (T5)`. Tipos: `feat`, `fix`, `test`, `refactor`, `docs`, `chore`.
- Al hacer commit, marca la tarea como hecha en `TASKS.md`, en el mismo commit.

## Comandos (desde `service/`)

| Comando | Qué hace |
|---|---|
| `npm run dev` | Arranca el servicio en local |
| `npm run lint` | ESLint |
| `npm run typecheck` | Comprobación de tipos |
| `npm test` | Unitarios e integración (sin Docker) |
| `npm run test:e2e` | E2E contra el Portal Sol real (requiere `docker compose --profile mongo up -d`) |

Se crean en la tarea de esqueleto. Si una tarea añade o cambia un comando, actualiza esta tabla y `service/README.md` en la misma tarea. Las variables de entorno están cerradas en la SPEC (*Configuración*): si crees que hace falta una nueva, para y pregunta.

## Reglas de código

- TypeScript en modo `strict`. Sin `any`.
- **Fechas**: todo pasa por el módulo de fechas en UTC. Nunca `new Date('YYYY-MM-DD')` sin validar con ida y vuelta, nunca `getDate`/`setDate` locales, nunca aritmética sobre el texto de la fecha.
- **Portal**: en el código del servicio, todas las llamadas pasan por el cliente único del portal (limitador, pausa por `429`, timeout). Nada más llama a `fetch` contra el portal. Los tests sí pueden llamarlo directamente (incluido `/__admin`).
- **MongoDB**: toda escritura de estado sobre un alojamiento (`POST`, worker, barrido) usa la condición de `rev` (concurrencia optimista) descrita en la SPEC, y sube `rev`. Excepción: las escrituras que solo tocan `leaseUntil` (reservar, renovar, liberar, reset al arrancar) son atómicas con su propio filtro y no tocan `rev`. `seq` solo sube con cada update aceptado y nunca es la condición.
- **Observabilidad**: los eventos de log y las métricas de la SPEC se llaman exactamente como ahí. Un evento que la SPEC pide registrar pero no nombra sigue el patrón `area.accion` (por ejemplo, `worker.storage_error`) y se lista al terminar la tarea para añadirlo a la SPEC. Nunca uses `accommodationId` como etiqueta de métrica.
- El código del servicio nunca llama a `/__admin/*`. Solo los tests pueden hacerlo.
- **Reloj**: los **instantes** que se guardan o comparan ("hoy", `nextAttemptAt`, `leaseUntil`, `pendingSince`) salen siempre del módulo de reloj del servicio, nunca de `Date.now()` o `new Date()` directamente, para que los tests puedan desplazarlo. El backoff y el margen tras timeout son instantes (`nextAttemptAt = now() + …`), no timers. Las **duraciones** (ventana del limitador, pausa por `429`, `durationMs`, histograma de latencia) se miden con `performance.now()` o timers, nunca con el reloj: si usaran el reloj, un test que lo adelanta vaciaría la ventana o se saltaría la pausa.

## Reglas de tests

- Los tests que tocan persistencia o portal usan MongoDB real con `mongodb-memory-server` y el portal falso; nunca el Portal Sol real (salvo el E2E). Los unitarios prueban funciones puras, sin MongoDB ni red.
- No hagas mock de MongoDB ni del código que se está probando.
- Tiempos (timeout, margen, backoff) configurables y muy cortos en tests. Nada de `sleep` fijos para esperar resultados: espera por condición con un tiempo máximo.
- Cada test es independiente: base de datos limpia y portal falso reiniciado.
- En tests de integración y E2E, nunca fechas de calendario fijas: genera las fechas relativas a "hoy" usando el reloj controlado. Los unitarios de fechas (funciones puras) sí pueden usar fechas fijas.
