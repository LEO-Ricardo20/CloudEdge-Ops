# Handoff Prompt for Another Agent

```text
You are continuing CloudEdge Ops at E:\个人项目project实践\CloudEdge-Ops.

Read completely before editing:
- README.md
- docs/ARCHITECTURE.md
- docs/API_CONTRACT.md
- server/domain/platform.js
- server/http.js
- server/index.js
- server/persistence/json-file-repository.js
- simulator/device-simulator.js
- tests/*.test.js
- web/index.html
- web/app.js
- web/styles.css

Current implemented baseline:
- Node.js 18+ with no third-party runtime dependencies.
- Multi-device telemetry and reported/desired device shadows.
- Temperature, vibration, and offline alerts.
- Alert lifecycle open -> acknowledged -> resolved.
- Strict, idempotent OTA state machine through success or failed.
- Complete command audit history.
- Atomic JSON persistence in data/platform-state.json.
- REST, SSE heartbeats, multi-device dashboard, and reconnect state.
- Domain, HTTP, persistence, and real simulator integration tests.

Before changing code:
1. Run git status and preserve unrelated user changes.
2. Run npm test and npm run test:integration.
3. Verify behavior rather than trusting documentation claims.
4. Keep domain, HTTP, persistence, simulator, and UI boundaries separate.

Engineering requirements:
- Use apply_patch for manual edits.
- Add tests for every domain or API behavior changed.
- Preserve command idempotency, legal state transitions, and audit history.
- Treat device timestamps as observations; liveness uses server receive time.
- Do not weaken persisted-state validation or transactional rollback.
- Render untrusted API data with DOM text APIs, not innerHTML.
- Do not commit, push, delete state, or install dependencies without authorization.
- Do not claim Go, MQTT, hardware, production scale, or AI diagnosis is implemented.

Recommended next milestone:
1. Add state backup rotation and explicit snapshot migrations.
2. Add device credentials, command expiry, rate limits, and server-side request identity.
3. Add contract tests suitable for a future Go implementation.
4. Prepare Docker Compose for PostgreSQL, Redis, and EMQX only when Docker is available.
5. Integrate one ESP32 device before starting STM32/FreeRTOS work.

At completion report changed files, exact verification results, browser QA, remaining limitations, and whether any server process remains running.
```
