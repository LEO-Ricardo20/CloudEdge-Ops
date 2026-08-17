# CloudEdge AI

> A cloud-edge device operations MVP for telemetry, device shadows, alerting, OTA workflows, and realtime observability.

CloudEdge AI is a portfolio project for connected industrial or robot devices. This repository contains a runnable MVP: a simulated edge device reports telemetry to an API service; the service maintains a device shadow, evaluates alerts, accepts OTA jobs, and pushes status changes to a browser dashboard through Server-Sent Events (SSE).

The project is deliberately structured so its MVP components can later be replaced by STM32/ESP32 firmware, MQTT/EMQX, Go/Gin, PostgreSQL/Redis, React/TypeScript, and Prometheus/Grafana without changing the core device, telemetry, alert, command, and OTA semantics.

This demo intentionally has no third-party runtime dependencies. It runs with Node.js 18+ so that the business loop can be demonstrated before adding a real board, Go services, MQTT, PostgreSQL, Docker, or cloud deployment.

## What works now

- Device registry and device shadow
- Simulated `robot-arm-01` telemetry every 1.2 seconds
- REST endpoints for devices, telemetry, alerts, commands, and OTA jobs
- SSE stream for dashboard updates
- Alert rules for temperature, vibration, and offline devices
- OTA job creation and staged device-side progress updates
- Recent command, telemetry, and alert event history
- Dark operations dashboard with live telemetry and event feed
- Node test suite for the core service behavior

## Why this project exists

Typical embedded demos stop at reading a sensor or driving a peripheral. Typical web demos stop at a dashboard page. CloudEdge AI connects the two sides of the operational problem:

```text
Edge telemetry -> device shadow -> alert evidence -> operator action -> OTA command -> device acknowledgement -> rollout result
```

That makes it a useful portfolio foundation for embedded software, IoT platform, backend, realtime frontend, robot-device operations, and later AI diagnostic roles.

## Run it

Open two PowerShell terminals in this directory.

Terminal 1:

```powershell
npm start
```

Terminal 2:

```powershell
npm run simulate
```

Then open [http://localhost:4173](http://localhost:4173). The dashboard seeds one online demo device, so it is still explorable before the simulator starts.

To reset the in-memory demo state, stop `npm start` and run it again.

## Demo flow

1. Start the API/dashboard service.
2. Start the device simulator; the telemetry table and line chart update live.
3. Click `Create OTA job` on the device card.
4. The service queues an OTA command; the simulator receives it and moves through `queued`, `downloading`, `installing`, and `success`.
5. Click `Inject temperature alert` to create a visible alert and observe the event stream.

## Project structure

```text
CloudEdge-AI/
  server/
    domain/           Business state and alert/OTA rules
    http.js           REST + SSE transport
    index.js          API server entry point
  simulator/          Runnable edge-device simulator
  web/                Dependency-free operations dashboard
  docs/               Architecture, roadmap, and agent handoff prompt
  tests/              Node test coverage for core domain behavior
```

## API summary

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Service health check |
| `GET` | `/api/devices` | List devices and shadows |
| `GET` | `/api/devices/:id` | Device detail and recent telemetry |
| `POST` | `/api/telemetry` | Device telemetry ingestion |
| `GET` | `/api/commands?deviceId=...` | Edge device polls queued commands |
| `POST` | `/api/commands/:id/ack` | Edge device acknowledges a command |
| `POST` | `/api/ota-jobs` | Create an OTA command/job |
| `GET` | `/api/alerts` | List alerts |
| `GET` | `/api/events/history` | List recent platform events |
| `POST` | `/api/demo/inject-alert` | Create a high-temperature demo alert |
| `GET` | `/api/events` | SSE stream for live dashboard updates |

## What changes for the formal version

The MVP uses in-memory state and HTTP polling to make the demo small. The formal architecture is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md):

- Node service -> Go/Gin services
- in-memory state -> PostgreSQL + Redis
- simulator HTTP -> STM32/ESP32 MQTT device agent
- in-process events -> EMQX/MQTT + event consumers
- browser dashboard remains React + TypeScript
- metrics -> Prometheus + Grafana

Read [docs/AGENT_HANDOFF_PROMPT.md](docs/AGENT_HANDOFF_PROMPT.md) before asking another agent to continue the project.

## Public repository and safety

This repository is designed to be published publicly. It contains simulated device data only. It must not contain production device credentials, broker addresses, private firmware binaries, internal company documents, user data, or real customer telemetry.

- Store local secrets only in `.env`; it is ignored by Git.
- Start from `.env.example` when environment variables are introduced.
- Keep firmware artifacts out of the repository unless they are independently licensed and safe to distribute.
- Do not make AI diagnosis capable of issuing device-control commands without explicit human approval, audit logs, and idempotency safeguards.

## License

Released under the [Apache License 2.0](LICENSE). You may use, modify, and publish the project while preserving the license and notices.
