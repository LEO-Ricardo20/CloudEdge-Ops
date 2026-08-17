# Priority Project Guide

This guide prevents the portfolio from becoming a collection of unrelated demos. Build one shared foundation, then choose one differentiated third project based on the role you want to apply for.

## Priority 1: CloudEdge AI

### Goal

Build a visible cloud-edge device operations loop: device data enters the platform, operators see live state, alerts are created, commands are delivered, and OTA progress is traceable.

### Formal stack

| Layer | Formal choice | First MVP choice |
| --- | --- | --- |
| Device | STM32G4 + FreeRTOS, CAN/RS485, MQTT | Node simulator, then ESP32 |
| Ingestion | Go/Gin + MQTT consumers | Node HTTP endpoint |
| Data | PostgreSQL, Redis, object storage | In-memory state |
| Realtime | SSE/WebSocket | SSE |
| Web | React + TypeScript | Vanilla browser UI |
| Operations | Prometheus, Grafana, Docker Compose | API health + event feed |

### Minimum demo acceptance criteria

1. One simulated device sends telemetry at a fixed interval.
2. Dashboard shows current shadow state, a telemetry trend, and an event feed.
3. An out-of-range metric creates an alert with an evidence snapshot.
4. An operator creates an OTA job; the device receives it and reports progress.
5. The complete sequence is recorded in a short demo video and explained by one architecture diagram.

### Resume-ready evidence after completion

- Git repository with README and API contract.
- Recorded demo of telemetry, alert and OTA flow.
- Measured data: duration, message rate, fault cases and recovery result.
- Screenshot of dashboard and test report.

## Priority 2: MetaCore AI

### Goal

Build an AI developer tool for embedded engineers: natural-language requirements become a cited hardware proposal, then a constrained C/C++ code scaffold, then a real compile result.

### Core flow

```text
Requirement -> Datasheet/manual retrieval -> constrained hardware plan
-> pin/BOM/connection output -> C/C++ code scaffold -> ARM GCC build
-> compile errors and evidence-backed repair suggestion
```

### Minimum demo acceptance criteria

1. Upload or index one STM32/ESP32 datasheet.
2. Ask a hardware question and return citations to source pages/chunks.
3. Generate a strict JSON plan for chip, peripherals, pins and BOM.
4. Generate a small C/C++ module using the plan.
5. Compile it or deliberately show a compile failure and explain the repair path.

### Non-negotiable constraints

- Do not allow the model to invent pins or electrical constraints.
- Every hardware claim must carry an evidence source.
- Keep generation separate from writing files or flashing a board.
- Human confirmation is required before any external action.

## Priority 3: choose one role-specific project

Do not build all three first. Pick one from the target role you actually plan to apply for.

### A. CreatorHub: Android commercial client

Pick this for Android, commercial client, subscription, or AI image-product roles.

Core flow:

```text
Login -> subscription purchase -> server validation -> entitlement state
-> AI creation task -> progress/cancel/retry -> local recovery after restart
```

Minimum proof: Kotlin + Compose app, fake BillingClient adapter, persisted entitlement state, weak-network test, and a screen-recorded purchase/recovery flow.

### B. CollabNote: collaborative rich-text editor

Pick this for React, frontend, Feishu-documents-style, editor, or collaboration roles.

Core flow:

```text
Rich-text schema -> editor transactions -> Yjs CRDT update
-> WebSocket sync -> awareness/cursor -> IndexedDB offline persistence
```

Minimum proof: two browser tabs synchronizing rich text, reconnect after offline edit, basic comments/cursors, a performance case, and Playwright coverage.

### C. BipedPilot plus RobotLink: robot C++ application

Pick this for C++, ROS 2, robot applications, or intelligent-device software roles.

Core flow:

```text
ROS 2 simulated sensors -> lifecycle nodes -> task/action layer
-> diagnostics and rosbag replay -> Qt control dashboard
```

Minimum proof: ROS 2 simulation, state/diagnostic node, injected fault, rosbag replay, C++ tests, and a Qt or web control panel.

## Recommended sequence for you

1. Finish CloudEdge AI MVP and attach it to your existing embedded/IoT background.
2. Build MetaCore AI only to a verifiable RAG -> structured plan -> compile loop.
3. Pick exactly one Priority 3 project when a target company or role becomes clear.

