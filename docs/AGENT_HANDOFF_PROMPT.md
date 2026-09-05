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
- v0.3: validated backup recovery, schema v2 migration, optional write/poll credentials, rate limits, server-owned expiry and health metrics.
- Protected mode leaves reads and SSE public on loopback; it is not private access control.
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
1. Read docs/IMPROVEMENT_PLAN.md and docs/VERIFICATION.md for current acceptance evidence.
2. Add private read authorization, token rotation and pagination before external deployment.
3. Retain contract tests during any protocol or storage migration.
4. Integrate one ESP32 device before starting STM32/FreeRTOS work.

At completion report changed files, exact verification results, browser QA, remaining limitations, and whether any server process remains running.
```
