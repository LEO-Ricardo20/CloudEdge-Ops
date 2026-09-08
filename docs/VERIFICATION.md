# v0.3 Verification

## v0.6 verification - 2026-09-08

- `npm test`: 46 passed, 0 failed.
- `npm run test:reliability`: 13 passed, 0 failed, including response loss after HTTP commit, identity conflicts, bounded-window eviction, JSON restore, unavailable transport and real simulator restart.
- `npm run test:browser`: demo and protected workflows passed, including authentication, alarm disposition, OTA and responsive layout.
- `git diff --check`: passed.
- Scope and reproducible scenarios: `docs/RELIABILITY.md`. The injected failure after HTTP commit is a test sender discarding the response, not a measured physical network outage.

## v0.5 verification - 2026-09-07

Local environment: Windows, Node.js v24.11.1, Chrome through Playwright Core.

- Full suite: 41 passed, 0 failed. Integration suite: 27 passed, 0 failed.
- Additional checks cover 15-second threshold formatting, null/string telemetry rejection, receive-time ordering, disposition-note retention and workflow closure while the sampled condition is still over threshold.
- Browser smoke in demo and protected modes covers connection filters, metric selection, blank-note rejection, disposition submission, OTA, login/logout, and desktop/mobile layouts (1440, 390 and 320 pixels).
- Mobile disposition dialog is checked for internal overflow and captured in `docs/screenshots/*-disposition-mobile.png`.
- Existing demo/protected desktop/mobile screenshots are regenerated from the current workflow. These are simulated measurements, not production evidence.
- Industry research is based on four successfully fetched official documentation pages; sources and implementation limits are in `docs/INDUSTRY_RESEARCH.md`. No user interviews or standards certification were performed.

The older records below describe their respective releases.

## v0.4 verification - 2026-09-07

Local environment: Windows, Node.js v24.11.1, installed Chrome through Playwright Core.

- `npm test`: 38 passed, 0 failed.
- `npm run test:integration`: 27 passed, 0 failed.
- `npm run test:browser`: demo and protected workflows passed. Both modes tested at 1440x1000, 390x844 and 320x740 without horizontal overflow or page errors.
- Protected browser checks: anonymous empty state, wrong-token rejection, successful authentication, alert lifecycle, OTA, device navigation, logout data clearing and locked reload.
- API checks: private read isolation, redacted health, SSE cookie privileges, expiry, replacement-session revocation, logout and rate limits.
- Screenshots: `docs/screenshots/demo-desktop.png`, `demo-mobile.png`, `protected-desktop.png`, `protected-mobile.png`.
- Browser checks require an existing Playwright/Playwright Core installation (`PLAYWRIGHT_MODULE` can point to it) and Chrome (`BROWSER_CHANNEL` defaults to `chrome`). Run `npm run test:browser`; it starts and cleans up temporary services itself.
- GitHub CI is configured for Windows/Linux with Node 22/24. A configured workflow is not proof of a successful remote run; consult Actions for the pushed commit.

The following v0.3 record is historical. In v0.4 protected read routes and SSE require authentication. Hardware OTA, TLS, live credential rotation, pagination and multi-user accounts remain unimplemented.

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
