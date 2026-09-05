# v0.3 Verification

Date: 2026-09-05 (Asia/Shanghai)

## Automated checks

| Check | Result |
| --- | --- |
| `npm test` | 33 passed, 0 failed |
| `npm run test:integration` | 22 passed, 0 failed |
| `git diff --check` | passed |
| Node.js simulator in demo mode | OTA success, restart and state restore passed |
| Node.js simulator in protected mode | device token polling, operator OTA, restart and state restore passed |
| CI definition | Windows/Linux matrix, Node 22/24, no third-party runtime dependency |

The test suite covers domain transitions, telemetry validation, alert lifecycle, command idempotency and expiry, schema migration, backup recovery, failed persistence writes, authentication boundaries, request IDs, rate limits, malformed URL encoding, SSE heartbeats/disconnects, and the real simulator.

## Browser smoke checks

Executed with headless Chrome through Playwright-compatible runtime:

- Desktop viewport: `1440x1000`
- Mobile viewport: `390x844`
- Narrow viewport: `320x740`
- SSE reaches connected state.
- Two devices render and can be searched and selected.
- Demo alert can be injected, acknowledged and resolved.
- OTA reaches success and displays the complete command timeline.
- Protected mode rejects an incorrect operator token, accepts the correct operator and device tokens, and completes the same workflow.
- No horizontal overflow at tested viewports.
- No page errors.

Screenshots are saved under `docs/screenshots/desktop.png` and `docs/screenshots/mobile.png` for local review. They are generated artifacts, not product runtime dependencies.

## Runtime cleanup

The browser smoke runner and integration tests terminate their HTTP servers and simulator processes. No CloudEdge process is intentionally left running after verification.

## Known limits

Protected mode protects mutation and device polling routes while local read routes and SSE remain public. JSON storage is single-process, synchronous and not designed for concurrent workers. OTA still simulates command stages; it does not download or verify a real firmware artifact, perform rollback or prove hardware reliability.
