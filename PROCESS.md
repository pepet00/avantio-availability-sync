# PROCESS — Cómo trabajé con la IA

## Qué delegué y qué hice yo

**Delegué a Claude (chat)** el análisis inicial del enunciado y de API.md, la propuesta de diseño y la redacción de los documentos: SPEC.md, `CLAUDE.md`, la skill de revisión `/revisar-tarea` y el subagente de solo lectura `revisor`. La skill y el subagente, igual que trabajar con un plan de tareas, fueron propuesta mía: quería que cada tarea la revisara alguien sin el contexto de quien la había escrito, y que el trabajo fuera por tareas pequeñas, siempre con la SPEC como referencia, para poder revisar y commitear cada una por separado. **Delegué a Claude Code** el plan (`TASKS.md`), la implementación tarea a tarea y las revisiones: la de cada tarea, mediante la skill, y las de la SPEC y del harness en sesiones con contexto limpio, pensadas para encontrar lo que una conversación larga da por obvio.

**Hice yo**, además de leer y corregir todo lo que redactó la IA antes de cada commit:

- **Medir el portal antes de diseñar**, con curl: el límite real de peticiones y cómo lo cuenta, la frecuencia de `503`, las latencias y si una petición cortada por timeout se aplica igual en el portal. De ahí salen el limitador de 25, el timeout de 15 s (y no 10, que cortaría respuestas a punto de llegar) y el margen de 30 s tras un timeout.
- **Las decisiones de diseño.** MongoDB en lugar de PostgreSQL. El modelo de estado deseado por día frente a una cola de updates, porque una cola permite que un reintento viejo pise un cambio nuevo. Que un update nuevo adelante el reintento, salvo en `failing` y dentro del margen tras timeout. No borrar los días pasados del documento. Y qué quitar del alcance: métricas y alertas extra, colección de auditoría y tratamiento especial del `401`.
- **Las dudas que la SPEC no cubría** y que el agente fue planteando durante la implementación: qué manda si un update llega mientras un PUT está en camino y falla, cómo tratar respuestas que no son JSON, cuándo no arrancar el servicio. Las decidí yo y el agente las dejó escritas en la SPEC.
- **Convertir reglas en comprobaciones.** A propuesta del revisor, la regla "los instantes salen del módulo de reloj" pasó de instrucción en `CLAUDE.md` a regla de ESLint. Una instrucción el agente la puede olvidar; el lint no.
- **Los commits**: el agente solo commitea cuando se lo pido, una tarea por commit, tras pasar la revisión.

## Dónde se equivocó la IA, qué descarté y cómo lo noté

- **Verificar con GET tras un timeout.** Claude propuso que, tras un timeout, el servicio consultara el portal con GET para saber si el PUT se había aplicado antes de reenviar. Al pedirle que me explicara la carrera que quería evitar (una petición vieja que el portal aplica después de que nosotros enviemos una nueva), quedó claro que lo que la evita es **esperar** un margen, no el GET: el GET no sabe si la petición vieja aún está en vuelo, y además gasta cuota del mismo límite. Lo cambié por esperar y reenviar el estado actual, que es seguro porque el PUT es idempotente.
- **`seq` como condición de la concurrencia optimista.** La SPEC redactada en el chat usaba `seq` (que solo sube con cada update) para detectar escrituras concurrentes. Como el worker no lo sube, un `POST` podía pisar lo que el worker acababa de escribir. No lo vi yo en la lectura. Lo encontró la revisión con contexto limpio que había montado precisamente porque no me fiaba de una SPEC escrita en una conversación larga, y yo decidí la solución: `rev`, que sube todo escritor.
- **Podar las fechas pasadas del documento.** Propuesto para evitar documentos grandes. Hice las cuentas (16 MB por documento dan para más de 100.000 días) y lo descarté. Volvió a aparecer tres veces en revisiones posteriores y mantuve la decisión.
- **Errores en el harness.** El primer `CLAUDE.md` exigía "un test por cada comportamiento nuevo", lo que invitaba al agente a inventarse tests fuera de los que la SPEC define. La primera skill copiaba los invariantes de la SPEC en lugar de remitir a ella. Y la restricción de solo lectura del revisor estaba en el sitio equivocado, en la skill, donde podía afectar también al agente principal, en vez de en el subagente. Los tres salieron al preguntarme y cuestionar cómo iba a funcionar cada pieza en la práctica.
- **Afirmar cosas sin comprobarlas.** En T2, el agente dijo que T1 no tenía commit basándose en el estado de git del inicio de la conversación; era falso. Desde entonces le exijo comprobar git y los ficheros antes de afirmar nada.
- **Tests de más.** Incluso después de corregir `CLAUDE.md`, en T4 añadió tests que ninguna tarea pedía. Los recorté y dejé la regla anotada.

Dejé de revisar la SPEC cuando una ronda dejó de cambiar comportamiento (cuatro cambios, uno, ninguno) y pasé a programar. Lo que quedara se decidiría implementando.

## Qué haría después

Todo lo estipulado en la SPEC está implementado. Lo que sigue son mejoras:

- **Varias instancias.** El reparto de trabajo ya funciona con varias (el lease y los reintentos viven en MongoDB), pero el limitador y la pausa por `429` viven en memoria y cada instancia superaría el límite del portal. Habría que compartirlos (un documento en MongoDB o Redis) y renovar el lease durante las esperas largas, que hoy pueden dejarlo caducar.
- **Reintento lento de los alojamientos en `error` por `404`.** Hoy se quedan parados hasta que llega un update nuevo. En la realidad un alojamiento puede no estar publicado todavía en el portal y aparecer más tarde, y un reintento cada hora lo recuperaría solo.
- **Reconciliación periódica con GET.** El margen tras un timeout reduce la carrera con una petición vieja, pero no la elimina si el portal tarda más que el margen. Comparar cada cierto tiempo el estado del portal con el deseado detectaría esas divergencias y las corregiría.
- **Un hook en el harness que fuerce la revisión** al terminar cada tarea, en vez de depender de que el agente siga la instrucción de `CLAUDE.md`.
- **Idempotencia explícita del `POST`** con una cabecera `Idempotency-Key`. Hoy un reenvío idéntico no cambia nada, pero sí genera un `updateId` y un log nuevos.
- **Sustituir `prom-client`**, deprecado en npm a favor de `@prometheus-io/client` (lo detectó el agente). Lo mantuve porque funciona y es el que fija la SPEC.
