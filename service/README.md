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

## Estructura

*Pendiente: describir las carpetas principales de `service/src` cuando estén creadas.*

## Mejoras futuras

- **Sustituir `prom-client`**: la versión 15.1.3 está marcada en npm como deprecada en favor de `@prometheus-io/client`. Funciona y se mantiene por ahora; el cambio queda dentro de `src/metrics/`.
