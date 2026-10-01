---
name: revisar-tarea
description: Revisión independiente de una tarea terminada de TASKS.md contra la SPEC. Úsala al terminar cada tarea, antes de proponer el commit. Recibe el identificador de la tarea (por ejemplo T3).
argument-hint: "[id de tarea, p. ej. T3]"
context: fork
agent: revisor
background: false
allowed-tools: Bash(git status *) Bash(git diff *) Bash(git log *) Bash(npm --prefix service run lint) Bash(npm --prefix service run typecheck) Bash(npm --prefix service test)
---

No escribiste este código y no modificas nada: solo revisas e informas. Quien invocó esta revisión corregirá lo que señales.

## Qué revisar

Tarea: **$ARGUMENTS**. Lee su definición en `TASKS.md`: objetivo, ficheros previstos y tests o criterios (CA-n) asignados.

Ficheros modificados y nuevos:

!`git status --short --untracked-files=all`

Diff de los ficheros con seguimiento (los nuevos, marcados `??` arriba, no salen aquí: léelos tú):

!`git diff HEAD -- . ':(exclude)**/package-lock.json'`

## Pasos

1. Desde la raíz del repo, ejecuta `npm --prefix service run lint`, `npm --prefix service run typecheck` y `npm --prefix service test` (así, sin `cd`, para que coincidan con los permisos preaprobados). Anota el resultado exacto.
2. Comprueba que la tarea hace lo que dice `TASKS.md` y nada más.
3. Comprueba uno por uno los **Invariantes** de la SPEC que afecten a esta tarea, y que los criterios de aceptación asignados están cubiertos por tests.
4. Comprueba las reglas de código y de tests de `CLAUDE.md`.
5. Además, busca expresamente lo que suele colarse y no es fácil de ver en el diff:
   - Fechas construidas con `new Date('...')` sin validar, `getDate`/`setDate` locales o aritmética sobre el texto. Instantes guardados que no salen del módulo de reloj, o duraciones (limitador, pausa, latencias) que sí salen de él.
   - Escrituras de estado en MongoDB (`POST`, worker, barrido) sin la condición de `rev` o que no suben `rev`, o que no reintentan si otra escritura se adelantó. Usar `seq` como condición es un error. Las escrituras que solo tocan `leaseUntil` son atómicas con su filtro y no tocan `rev`: no las marques.
   - Llamadas al portal fuera del cliente único, o sin timeout.
   - Estado en memoria que debería sobrevivir a un reinicio. Excepciones aceptadas por la SPEC: la pausa por `429` y la ventana del limitador.
   - Tests que pasarían igualmente con una implementación rota, mocks de MongoDB o del propio código bajo prueba, `sleep` fijos.

Cada problema que señales debe llevar fichero y línea, o la salida del comando que lo demuestra. Si no tienes evidencia, no lo afirmes.

## Formato de la respuesta

**Veredicto**: OK / CAMBIOS NECESARIOS

**Verificaciones**: resultado de lint, typecheck y tests (número de tests y fallos).

**Problemas bloqueantes**: uno por punto, con fichero:línea, qué incumple (tarea, invariante, criterio o regla de `CLAUDE.md`), por qué y qué cambiarías.

**Mejoras no bloqueantes**: breves.

**Dudas sobre la SPEC**: si la SPEC es ambigua o el código revela un caso que no contempla.
