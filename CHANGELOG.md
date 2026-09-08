# Changelog

## 0.6.0 - 2026-09-08

- Add opt-in telemetry identity using device, boot ID and sequence; deduplicate within each device's 240 retained samples without writes, events or liveness refresh.
- Reject conflicting identity reuse, preserving legacy telemetry clients without identity fields.
- Retain one simulator sample until acknowledgement; retry the original timestamp and payload after a transport/server failure. Generate a new boot ID for each simulator process.
- Add reproducible response-loss, transport-failure, server-restore, device-restart and deduplication-window tests through `npm run test:reliability`.
- Document bounded retry guarantees; MQTT, hardware OTA and durable offline buffering remain future work.

## 0.5.0 - 2026-09-07

- Research official AWS IoT, Azure IoT Hub and ThingsBoard terminology, with sources and scope recorded in `docs/INDUSTRY_RESEARCH.md`.
- Present alarm disposition separately from the latest observed threshold condition; require a disposition note in the dashboard closure dialog while preserving the existing API.
- Add connection-state filtering, reported/desired firmware alignment and distinct receive/observation timestamps.
- Add temperature, vibration velocity, battery and motor-speed trends using actual receive-time spacing; reject null/non-numeric samples and label historical data for offline devices.
- Use consistent Chinese operations terminology and explicitly label simulated OTA tasks. Preserve seconds for short offline thresholds.
- Extend domain/presentation and browser verification for closure notes, state filters and metric selection.

## 0.4.0 - 2026-09-07

- Require operator authentication for fleet, alerts, metrics and event history in protected mode; scope device detail reads to the operator or that device.
- Authenticate SSE through operator bearer headers or opaque 30-minute HttpOnly/SameSite event cookies. Revoke streams on logout, replacement login and expiry; cookies cannot authorize REST writes or reads.
- Clear browser credentials and private data on logout/authentication failure; require authentication again after reload.
- Redact anonymous health responses, reject shared identity tokens, limit API authentication attempts, reclaim expired limiter buckets and disconnect slow SSE clients.
- Verify anonymous/device denial, cookie privilege boundaries, expiration/revocation, and browser login/OTA/logout across desktop and mobile widths.
- Clarify evidence: CI configuration alone is not a successful remote CI run. Real hardware, live credential rotation, pagination and multi-user accounts remain future work.

## 0.3.0 - 2026-09-05

- Retain and finish the local v0.3 work: snapshot migration, three backup generations, operator/device credentials, rate limiting, request IDs, command expiry, health metrics and dashboard filters.
- Preserve the committed primary snapshot if its atomic replacement fails; roll back memory and publish no uncommitted events. Expose persistence failures as degraded health (HTTP 503), recover health after a successful write, and keep scheduled evaluations alive after storage errors.
- Enforce expiry on the server, reject device-reported expiry, and free expired OTA slots before creating new jobs.
- Validate runtime configuration at startup; verify dashboard credentials through an authenticated identity endpoint.
- Serialize simulator loops with request timeouts and verify OTA completion and restart in both demo and protected modes.
- Add failure-path, authorization and SSE regression coverage, plus Windows/Linux CI for Node.js 22 and 24.
- Document the public-read boundary of protected mode, environment setup, recovery behavior and evidence-based next milestones.
