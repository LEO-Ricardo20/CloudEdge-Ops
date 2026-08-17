<p align="right">
  <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a>
</p>

# CloudEdge AI

> A persistent cloud-edge device operations MVP for telemetry, device shadows, alert lifecycle management, OTA workflows, and realtime observability.

CloudEdge AI is a portfolio project for connected industrial and robot devices. A simulated edge device reports telemetry to a Node.js service; the service maintains a device shadow, evaluates threshold and offline alerts, delivers auditable OTA commands, persists operational state, and streams changes to a browser dashboard through Server-Sent Events (SSE).

This repository implements the local Node.js MVP. It does not claim real hardware, MQTT, Go services, production scale, or AI diagnosis. Those remain explicit future milestones.

## Demonstrated operational loop

```text
Device telemetry -> reported shadow -> alert evidence -> operator acknowledgement
-> alert resolution / OTA request -> device command polling -> staged progress
-> success or failure -> firmware alignment -> persistent audit history
```

## What works now

- Automatic device registration and multi-device dashboard navigation
- Persistent reported/desired device shadows and recent telemetry history
- Temperature, vibration, and offline alert rules
- Alert lifecycle: `open -> acknowledged -> resolved`, including retriggering
- OTA state machine: `queued -> acknowledged -> downloading -> installing -> success|failed`
- Idempotent command acknowledgement and progress retries
- Complete command history and per-command progress timeline
- JSON persistence with atomic temporary-file replacement
- SSE updates with visible connecting, connected, and reconnecting states
- Request validation, bounded JSON bodies, structured error codes, and `409` state conflicts
- Domain, HTTP, persistence, and real simulator integration tests

## Run locally

Requirements: Node.js 18 or newer. There are no third-party runtime dependencies.

Open two PowerShell terminals in this directory.

Terminal 1:

```powershell
npm start
```

Terminal 2:

```powershell
npm run simulate
```

Open [http://localhost:4173](http://localhost:4173).

Runtime state is stored in `data/platform-state.json`, which is ignored by Git. To start a deliberately clean demo, stop the service, remove that file, and restart the service.

Optional environment variables are documented in [`.env.example`](.env.example). PowerShell example:

```powershell
$env:OFFLINE_AFTER_MS = "10000"
$env:DEVICE_ID = "robot-arm-02"
npm run simulate
```

## Demo flow

1. Start the service and simulator.
2. Select a device and watch telemetry update in realtime.
3. Create an OTA job with a target version.
4. Observe queued, acknowledged, downloading, installing, and success states.
5. Inject a high-temperature alert, acknowledge it, and resolve it.
6. Stop the simulator long enough to create an offline alert; restart it to observe automatic recovery.
7. Restart the service and confirm that devices, alerts, commands, telemetry, and events are restored.

## Verification

```powershell
npm test
npm run test:integration
```

The integration suite starts a real HTTP server and device simulator process, completes an OTA job to `success 100%`, verifies reported/desired firmware alignment, and restores the result from a temporary JSON state file.

## Project structure

```text
CloudEdge-AI/
  server/
    domain/                 Device, telemetry, alert, command, and OTA rules
    persistence/            JSON state repository
    http.js                 REST, validation, static files, and SSE transport
    index.js                Runtime composition and offline scheduler
  simulator/                Runnable edge-device simulator
  web/                      Dependency-free multi-device operations dashboard
  tests/                    Domain, HTTP, persistence, and simulator tests
  docs/                     Architecture, API contract, roadmap, and handoff guide
```

## API

The full contract and state-transition rules are documented in [docs/API_CONTRACT.md](docs/API_CONTRACT.md).

Important endpoints include:

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/devices` | List registered devices and latest telemetry |
| `GET` | `/api/devices/:id` | Device detail, telemetry, active commands, and command history |
| `POST` | `/api/telemetry` | Ingest telemetry and reported shadow state |
| `GET` | `/api/commands?deviceId=...` | Poll active commands |
| `GET` | `/api/commands?deviceId=...&scope=all` | Read complete command history |
| `POST` | `/api/ota-jobs` | Create an OTA command |
| `POST` | `/api/commands/:id/ack` | Acknowledge command receipt |
| `POST` | `/api/commands/:id/progress` | Report staged progress or terminal result |
| `POST` | `/api/alerts/:id/acknowledge` | Acknowledge an open alert |
| `POST` | `/api/alerts/:id/resolve` | Resolve an acknowledged alert |
| `GET` | `/api/events` | Subscribe to the SSE event stream |

## Current boundaries

- JSON persistence is synchronous and intended for a single local process.
- There is no device authentication, tenant isolation, firmware signing, real artifact transfer, rollback, or resumable OTA.
- Online/offline liveness uses the server receive time; device timestamps are retained only as observation time and are not yet protected by clock-skew policy or device identity verification.
- There is no implemented AI diagnostic service. Future AI work must begin read-only and cite telemetry, logs, and documents.
- No scale, uptime, hardware, or OTA reliability claims should be made without measured evidence.

The formal architecture direction is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Public repository safety

Only simulated data belongs in this repository. Do not commit `.env`, API keys, broker credentials, production addresses, private firmware, company documents, user data, or customer telemetry.

## License

Released under the [Apache License 2.0](LICENSE).
