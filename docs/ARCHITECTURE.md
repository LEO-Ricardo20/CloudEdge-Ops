# CloudEdge AI Architecture

## Product statement

CloudEdge AI is a cloud-edge operations platform for connected industrial and robot devices. The current repository proves a reliable local path from telemetry to device state, evidence-bearing alerts, operator actions, OTA command delivery, persistent audit history, and realtime visualization.

## Implemented local architecture

```mermaid
flowchart LR
  Edge[Node device simulator] -->|HTTP telemetry| API[Node HTTP service]
  Edge -->|Poll active commands| API
  API --> Domain[Device, alert and OTA domain]
  Domain --> JSON[(Atomic JSON state file)]
  API -->|REST| UI[Browser operations dashboard]
  API -->|SSE events| UI
  UI -->|Acknowledge / resolve / create OTA| API
  Timer[Offline evaluation timer] --> Domain
```

The MVP intentionally uses Node.js, HTTP polling, SSE, and a JSON repository. The domain, HTTP transport, persistence, simulator, and UI remain separate so each can be replaced without changing the operational semantics.

## Runtime responsibilities

| Component | Responsibility |
| --- | --- |
| `server/domain/platform.js` | Device shadow, telemetry history, alert lifecycle, OTA state machine, events, snapshots |
| `server/persistence/json-file-repository.js` | Load state and atomically replace the local JSON state file |
| `server/http.js` | REST routing, validation, error mapping, SSE, and static asset serving |
| `server/index.js` | Compose runtime dependencies and schedule offline evaluation |
| `simulator/device-simulator.js` | Report telemetry, poll commands, acknowledge and advance OTA stages |
| `web/` | Multi-device operations UI and realtime status |

## Domain invariants

- Active OTA states are `queued`, `acknowledged`, `downloading`, and `installing`.
- Terminal OTA states are `success` and `failed`.
- Progress cannot regress; skipped stages and invalid terminal updates are rejected with `409`.
- Identical acknowledgement and progress retries do not duplicate history or events.
- Only one OTA command may be active for a device.
- Alerts move through `open`, `acknowledged`, and `resolved`.
- A manually resolved threshold alert can be triggered again as a new alert.
- An offline alert is deduplicated while active and automatically resolved when telemetry resumes.
- Every domain mutation is persisted before realtime subscribers are notified.

Detailed request/response behavior is in [API_CONTRACT.md](API_CONTRACT.md).

## Persisted state

The versioned snapshot contains devices, recent telemetry, alerts, commands including histories, and compact audit events. The default file is `data/platform-state.json`; it is intentionally ignored by Git.

Writes use a same-directory temporary file followed by rename. Invalid JSON is reported at startup rather than silently discarded. This is appropriate for one local demo process, not for concurrent services or high ingestion rates.

## Formal architecture after the MVP

```mermaid
flowchart LR
  subgraph Edge[Edge Device]
    Firmware[STM32 or ESP32 firmware]
    Agent[Identity, protocol and OTA agent]
    Sensors[Sensor and actuator drivers]
    Sensors --> Firmware --> Agent
  end

  Agent -->|mTLS MQTT| Broker[EMQX]
  Broker --> Ingest[Go telemetry ingestion]
  Broker --> Command[Go command and OTA service]
  Ingest --> PG[(PostgreSQL / TimescaleDB)]
  Ingest --> Redis[(Redis)]
  Ingest --> Alert[Alert rules service]
  Command --> Object[Signed firmware storage]
  API[Go BFF / API gateway] --> PG
  API --> Redis
  Web[React and TypeScript dashboard] -->|REST / SSE| API
  Metrics[Prometheus and Grafana] --> Ingest
  Metrics --> Command
  API --> AI[Read-only diagnostic service]
  AI --> Evidence[Telemetry, logs and cited documents]
```

This diagram is a roadmap, not an implementation claim.

## Next milestones

1. Add backup rotation and explicit state-schema migration for the local repository.
2. Introduce device credentials, server receive timestamps, rate limits, and command expiry.
3. Add Docker Compose with PostgreSQL, Redis, and EMQX.
4. Port the proven domain behavior to Go while retaining the current contract tests.
5. Integrate one ESP32 device before STM32/FreeRTOS work.
6. Add observability and only then a read-only, evidence-backed diagnostic workflow.

## Boundaries

- Do not claim production scale, measured uptime, real OTA reliability, hardware integration, or AI accuracy without evidence.
- AI diagnosis must not issue control commands. Future control actions require explicit human approval, authorization, audit logging, expiry, and idempotency.
- Real OTA requires signed artifacts, checksum verification, rollback, retry, resume, and secure device identity.
