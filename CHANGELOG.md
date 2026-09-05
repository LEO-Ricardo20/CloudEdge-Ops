# Changelog

## 0.3.0 - 2026-09-05

- Retain and finish the local v0.3 work: snapshot migration, three backup generations, operator/device credentials, rate limiting, request IDs, command expiry, health metrics and dashboard filters.
- Preserve the committed primary snapshot if its atomic replacement fails; roll back memory and publish no uncommitted events. Expose persistence failures as degraded health (HTTP 503), recover health after a successful write, and keep scheduled evaluations alive after storage errors.
- Enforce expiry on the server, reject device-reported expiry, and free expired OTA slots before creating new jobs.
- Validate runtime configuration at startup; verify dashboard credentials through an authenticated identity endpoint.
- Serialize simulator loops with request timeouts and verify OTA completion and restart in both demo and protected modes.
- Add failure-path, authorization and SSE regression coverage, plus Windows/Linux CI for Node.js 22 and 24.
- Document the public-read boundary of protected mode, environment setup, recovery behavior and evidence-based next milestones.
