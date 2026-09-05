<p align="right">
  <strong>English</strong> | <a href="./README.zh-CN.md">简体中文</a>
</p>

# CloudEdge Ops

> A persistent cloud-edge device operations MVP for telemetry, device shadows, alert lifecycle management, OTA workflows, and realtime observability.

CloudEdge Ops is a portfolio project for connected industrial and robot devices. A simulated edge device reports telemetry to a Node.js service; the service maintains a device shadow, evaluates threshold and offline alerts, delivers auditable OTA commands, persists operational state, and streams changes to a browser dashboard through Server-Sent Events (SSE).

This repository implements the local Node.js MVP. It does not claim real hardware, MQTT, Go services, production scale, or AI diagnosis. Those remain explicit future milestones.

Current release: **v0.3.0**. Formerly named CloudEdge AI. See the [improvement plan](docs/IMPROVEMENT_PLAN.md) and [release notes](CHANGELOG.md).

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
- Three rotating state backups, validated recovery, and v1-to-v2 snapshot migration
- Optional operator/device bearer credentials for writes and command polling
- Server-owned OTA expiry, request tracing, rate limits, and health/metrics endpoints

## Run locally

Requirements: Node.js 18 or newer; Node.js 22 or 24 LTS is recommended and covered by CI on Linux and Windows. There are no third-party runtime dependencies.

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

Runtime state is stored in `data/platform-state.json`, with three `.bak.1` through `.bak.3` backups, all ignored by Git. Missing or invalid primary state recovers from the newest valid backup. For a clean demo without deleting existing state, launch with a new `STATE_FILE` path.

Optional environment variables are documented in [`.env.example`](.env.example). PowerShell example:

```powershell
$env:OFFLINE_AFTER_MS = "10000"
$env:DEVICE_ID = "robot-arm-02"
npm run simulate
```

Environment variables apply to the process started in that terminal. Set `OFFLINE_AFTER_MS` in the server terminal. `.env` is not loaded automatically; use PowerShell variables or Node 22+ `node --env-file=.env server/index.js`.

### Protected local demo

Server terminal (replace the sample tokens):

```powershell
$env:AUTH_MODE = "protected"
$env:OPERATOR_TOKEN = "local-operator-example"
$env:DEVICE_TOKENS = '{"robot-arm-01":"local-device-example"}'
npm start
```

Simulator terminal:

```powershell
$env:DEVICE_TOKEN = "local-device-example"
npm run simulate
```

Enter the operator token in the dashboard's access settings. Tokens stay in page memory. **Protected mode authenticates mutations and device command polling; dashboard reads, metrics and SSE remain public on the loopback service.** It is not a private or multi-tenant deployment. Invalid authentication configuration stops startup. Defaults allow 1,000 requests per minute per write category and identity/IP, returning `429` and `Retry-After` when exceeded.

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
CloudEdge-Ops/
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
- Device bearer tokens are optional; tenant isolation, private read access, TLS, firmware signing, real artifact transfer, rollback, and resumable OTA are not implemented.
- Online/offline liveness uses server receive time; device timestamps are retained as observation time without a clock-skew policy.
- There is no implemented AI diagnostic service. Future AI work must begin read-only and cite telemetry, logs, and documents.
- No scale, uptime, hardware, or OTA reliability claims should be made without measured evidence.

The formal architecture direction is described in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Public repository safety

Only simulated data belongs in this repository. Do not commit `.env`, API keys, broker credentials, production addresses, private firmware, company documents, user data, or customer telemetry.

## License

Released under the [Apache License 2.0](LICENSE).
