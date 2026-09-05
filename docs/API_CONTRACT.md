# CloudEdge Ops API Contract

All responses use JSON except static assets and the SSE stream. Mutation errors include an `error` message and, when available, a stable `code`.

## Error behavior

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, field, timestamp, URL, query, status, or progress |
| `401` | Required bearer token missing |
| `403` | Incorrect token or wrong device identity |
| `404` | Device, alert, command, or route not found |
| `409` | State conflict, active OTA conflict, skipped transition, or progress regression |
| `413` | JSON body exceeds 64 KiB |
| `429` | Write rate limit exceeded; retry after `Retry-After` seconds |
| `500` | Unexpected server or persistence failure |
| `503` | Health check reports a persistence failure |

Every response has `X-Request-Id`. A safe client-supplied ID is retained; otherwise one is generated. Ordinary JSON responses below 500 also include `requestId`. Unexpected failures return generic errors without filesystem details or credentials.

## Authentication and health

The server binds to `127.0.0.1`. `AUTH_MODE=demo` is the default. `AUTH_MODE=protected` requires `OPERATOR_TOKEN` and a JSON `DEVICE_TOKENS` map at startup.

| Routes | Protected-mode credential |
| --- | --- |
| Telemetry, device command polling, command ack/progress | `Authorization: Bearer <token>` for the specific device |
| OTA creation, alert acknowledge/resolve, demo injection | Operator bearer token |
| `GET /api/auth/operator` | Operator bearer token; returns `{ actor, authMode }` for credential verification |
| Health, metrics, device reads, alert reads, event history, SSE | Public local reads |

Protected mode is write protection, not private data access. Do not expose the local service as a private deployment. Device tokens are never returned by an endpoint. In protected mode the alert actor is the authenticated operator, not the request body's actor.

`GET /api/health` returns `ok`, `status`, `persistence`, `schemaVersion`, `recovery`, and `authMode`. Failed persistence changes status to `degraded` and HTTP 503; successful persistence restores status to `ok`. Backup recovery includes source path and index. `GET /api/metrics` returns device/command/alert counts, SSE client count and HTTP request/error/rate-limit counters.

Write limits default to 1,000 requests per 60 seconds per category (`telemetry` or `operatorWrite`) and identity/IP. Command polling and command progress are not currently rate-limited.

## Device and telemetry

- `GET /api/devices` returns `{ devices }` with each device's latest telemetry.
- `GET /api/devices/:id` returns `{ device }` with `recentTelemetry`, active `pendingCommands`, and complete `commandHistory`.
- `POST /api/telemetry` requires `deviceId` and a `metrics` object containing finite numeric values. `reportedState` is optional.
- Unknown device IDs are registered automatically on first telemetry.

## Alerts

- `GET /api/alerts` lists all alerts; `?status=open|acknowledged|resolved` filters them.
- `POST /api/alerts/:id/acknowledge` accepts `{ "actor": "operator" }`.
- `POST /api/alerts/:id/resolve` accepts `{ "actor": "operator", "reason": "Inspection complete" }`.

Manual lifecycle:

```text
open -> acknowledged -> resolved
```

Repeated identical acknowledgement or resolution is idempotent. Manual resolution requires prior acknowledgement. Connectivity alerts may be resolved directly by the system when telemetry resumes.

## OTA commands

- `POST /api/ota-jobs` accepts `deviceId`, `targetVersion`, and optional `artifactUrl`, `checksum`, `requestId`, and either `expiresInSeconds` or `expiresAt`.
- `GET /api/commands?deviceId=:id` returns active commands for device polling.
- Add `scope=all` to return active and terminal command history.
- `POST /api/commands/:id/ack` acknowledges a queued command.
- `POST /api/commands/:id/progress` accepts numeric `progress` and `status`.

State machine:

```text
queued -> acknowledged -> downloading -> installing -> success
                                                \-> failed
Any active state -> expired (server-owned deadline)
```

Rules:

- Progress is between 0 and 100 and cannot regress.
- Success requires 100% and may only follow installing.
- Failed may only follow installing.
- Terminal commands cannot change.
- `expiresInSeconds` must be an integer from 1 to 2,592,000. `expiresAt` must be a future date within 30 days. Default TTL is 24 hours (`COMMAND_TTL_MS`).
- The server evaluates expiry on its timer and before create/ack/progress/poll operations. Devices cannot submit `expired` as a progress status. Expiry preserves reported firmware and the desired target, and adds one terminal audit entry.
- Identical retries return the existing command without adding audit entries.
- A device may have only one active OTA command.
- `requestId` is an optional idempotency key. Reuse with a different device or normalized OTA payload returns `409 IDEMPOTENCY_KEY_REUSE`.

## Events

- `GET /api/events/history?limit=40` returns recent compact audit events.
- `GET /api/events` opens the SSE stream.

Emitted event types are `device.updated`, `telemetry.updated`, `alert.created`, `alert.updated`, `command.created`, and `command.updated`.

The server sends SSE comment heartbeats while connections are open. The MVP does not yet implement replay with `Last-Event-ID`.

## Demo endpoint

`POST /api/demo/inject-alert` accepts an optional `deviceId` and injects a high-temperature telemetry reading. It exists only for the public demonstration workflow.
