# CloudEdge AI API Contract

All responses use JSON except static assets and the SSE stream. Mutation errors include an `error` message and, when available, a stable `code`.

## Error behavior

| Status | Meaning |
| --- | --- |
| `400` | Invalid JSON, field, timestamp, URL, query, status, or progress |
| `404` | Device, alert, command, or route not found |
| `409` | State conflict, active OTA conflict, skipped transition, or progress regression |
| `413` | JSON body exceeds 64 KiB |
| `500` | Unexpected server or persistence failure |

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

- `POST /api/ota-jobs` accepts `deviceId`, `targetVersion`, and optional `artifactUrl`, `checksum`, and `requestId`.
- `GET /api/commands?deviceId=:id` returns active commands for device polling.
- Add `scope=all` to return active and terminal command history.
- `POST /api/commands/:id/ack` acknowledges a queued command.
- `POST /api/commands/:id/progress` accepts numeric `progress` and `status`.

State machine:

```text
queued -> acknowledged -> downloading -> installing -> success
                                                \-> failed
```

Rules:

- Progress is between 0 and 100 and cannot regress.
- Success requires 100% and may only follow installing.
- Failed may only follow installing.
- Terminal commands cannot change.
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
