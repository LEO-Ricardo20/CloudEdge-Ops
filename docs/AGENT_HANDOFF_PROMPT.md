# Handoff Prompt for Another Agent

Copy the following prompt when you want another coding agent to continue this project.

```text
You are continuing the project at E:\个人项目project实践\CloudEdge-AI.

Read these files completely before making changes:
- README.md
- docs/ARCHITECTURE.md
- docs/PROJECT_PRIORITY_GUIDE.md
- server/domain/platform.js
- server/http.js

Project objective:
CloudEdge AI is a cloud-edge IoT device operations portfolio project. The first runnable MVP must demonstrate this complete loop:
1. A simulated device sends telemetry.
2. The backend updates a device shadow and recent telemetry history.
3. Alert rules create a visible alert when a metric is out of range.
4. The web dashboard receives realtime changes via SSE.
5. An operator creates an OTA job.
6. The simulated device polls, acknowledges, and reports staged OTA progress.

Current constraints:
- This Windows machine currently has Node.js but no Go or Docker. Keep the existing Node-only MVP runnable with no runtime npm dependencies unless the task explicitly installs prerequisites.
- Do not replace the current REST/SSE endpoint semantics without updating README.md and docs/ARCHITECTURE.md.
- Do not fabricate benchmark numbers, real hardware integration, or AI-diagnosis results.
- Use apply_patch for edits. Preserve existing user files and do not use destructive git commands.

Required engineering standards:
- Maintain JavaScript test coverage in tests/ for every domain behavior you change.
- Keep the dashboard usable at 1280px desktop width and test the main browser flow manually.
- Retain clean separation between domain state/rules, HTTP transport, simulator, and UI.
- Any command delivery must remain idempotent and auditable.
- Any future AI operation is read-only by default and requires evidence/citations; do not add autonomous control actions.

Suggested next task, in order:
1. Inspect the current app and run `npm test`, `npm start`, and `npm run simulate`.
2. Add alert acknowledgement and resolution endpoints plus UI actions and tests.
3. Add JSON persistence behind a small repository interface without changing the domain API.
4. Add command audit history in the device detail view.
5. Only after that, prepare a Go/Gin migration plan and Docker Compose design; do not claim they are implemented unless actually delivered.

At the end, report changed files, exact verification commands/results, remaining limitations, and the local URL if a server is running.
```

