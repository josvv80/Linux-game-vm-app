# Game VM Hub

Game VM Hub is a Linux-hosted control app for browsing, launching, and monitoring Windows PC games that run inside a Windows gaming environment.

## What We Are Building

This project is trying to make Windows gaming feel appliance-like from Linux.

Instead of treating a Windows VM as a separate machine you manually boot, log into, and manage, Game VM Hub aims to provide one control surface that can:

- show your installed games in a web UI
- start or reconnect to the Windows gaming environment
- launch a selected game from Linux
- report what stage the launch is in
- tell you when remote play is ready
- surface failures and recovery actions when something breaks

The intended user experience is closer to a console-style game hub than a traditional VM workflow.

## Product Goal

The goal is not to make Windows games run natively on Linux.

The goal is to use Linux as the host and orchestration layer while Windows remains the primary game runtime. In practical terms:

- Linux runs the control app
- Windows runs the launchers and games
- the app hides as much VM and launcher complexity as possible
- the setup should work well even when the Linux host loses the GPU during play

## Target Play Model

The current preferred direction is a remote-first single-GPU passthrough setup:

- Linux host starts and manages the Windows VM
- Windows guest owns the GPU during gameplay
- Sunshine runs inside the Windows guest
- Moonlight on another device is the main play surface
- the host web UI remains available remotely for admin and recovery tasks

## Main Features Planned

The finished app is meant to provide:

- a unified game library across Windows launchers
- launcher discovery, starting with Steam and later Ubisoft Connect
- runtime controls for starting, stopping, and recovering the Windows gaming environment
- game launch controls from a Linux browser UI
- status tracking for launch, process detection, and stream readiness
- explicit remote-client attachment and detachment after the stream path is ready
- diagnostics for guest reachability, event-stream health, and remote-play readiness
- explicit distinction between:
  - guest reachable
  - active game session running
  - stream-ready session available for remote play
  - remote client already attached
- operator guidance and recovery paths when the guest, launcher handoff, or stream path fails
- one-step stalled-launch recovery that can terminate a stuck active launch, refresh the guest control link, and relaunch the same game
- a host/guest contract that keeps the Linux UI and Windows runtime loosely coupled

## Current Implementation

The current repo is an early but real end-to-end control-plane prototype.

It already includes:

- npm workspaces monorepo with `apps/*` and `packages/*`
- shared TypeScript contracts for games, sessions, runtime state, diagnostics, and dashboard messages
- `catalog-core` helpers for game merging, launch eligibility, and session ordering
- `runtime-sdk` providers for:
  - a fully fake runtime used for host-side development
  - a managed-VM path that talks to a guest-agent HTTP contract
- `host-api` Fastify server with REST endpoints and WebSocket dashboard updates
- `host-web` React/Vite dashboard for:
  - runtime controls
  - provider and guest configuration
  - game catalog browsing
  - launch actions
  - diagnostics and recovery guidance
  - session timeline visibility
  - guest simulation controls for testing edge cases
- `guest/windows-agent` .NET 10 prototype with:
  - health, scan, launch, terminate, and simulation endpoints
  - Server-Sent Events lifecycle streaming
  - staged session state transitions
  - early Steam discovery
  - early Steam launch handoff attempts
  - lightweight process observation with simulated fallback behavior
  - early Sunshine process/listener observation with simulated stream-ready fallback behavior

This means the host control plane is already working, but the VM/runtime layer and parts of the guest behavior are still prototype-grade.

## What Works Today

Today the project can already demonstrate:

- a browser dashboard running on Linux
- persisted host-side configuration
- runtime provider selection
- managed guest health checks and event streaming
- automatic managed-guest event-stream retry when the guest stays reachable but the control stream drops
- catalog scanning
- session launch and termination flows
- remote-play and guest-link diagnostics in the UI
- explicit event-stream state reporting so the UI distinguishes connected, reconnecting, and disconnected control-link conditions
- remote-play stall detection so the UI can distinguish a normal stream warm-up from a guest session that has exceeded its expected stream-ready window
- attach-display and detach-display handoff controls from the host UI once remote play is ready
- active-session-aware remote-play diagnostics so the UI does not claim the stream is playable after a session has already ended
- recent session history with one-click relaunch for completed or failed sessions when the guest is ready again
- selected-game detail view with explicit launch-readiness and blocked-launch reasons
- persistent pinned games for quick launch and faster repeat access
- pinned games stay visible even when a later scan does not currently rediscover them
- pinned games can be reordered and missing pins can be cleared in bulk
- guest-side success and failure simulation without code changes
- configurable guest-side Sunshine probe process names and ports for stream-readiness experiments
- direct Sunshine stream-host probe actions from the host UI without launching a game, including normalized probe target and timing input for both tests and saved scenarios, adding observed process/port targets back into the scenario config, resetting empty saved target lists to provider defaults, and identifying when those targets are already covered
- visibility into whether a game came from real Steam discovery or sample fallback data
- guest launch-path details such as Steam handoff attempts and observed process metadata
- guest stream-readiness details showing whether Sunshine was observed or the scaffold used simulated readiness

## What Is Not Finished Yet

The major remaining gaps are:

- real libvirt/QEMU lifecycle control
- real VFIO and single-GPU passthrough orchestration
- production-grade Windows guest-agent behavior
- complete Steam integration
- Ubisoft Connect discovery and launch support
- explicit Sunshine/Moonlight readiness orchestration
- stronger reconnect, failure, and recovery handling around the guest runtime

## Architecture Direction

- Linux host app:
  - browser-first React UI
  - local Fastify API
  - TypeScript across the host stack
  - persisted host config in `data/host-config.json`
- Windows guest:
  - .NET service/agent
  - Steam plus Ubisoft Connect as the first real launcher scope
  - host/guest contract documented in `guest/windows-agent/CONTRACT.md`
- VM/runtime layer:
  - long-term direction is KVM/QEMU with VFIO GPU passthrough
  - current machine only shows one discrete AMD GPU, so single-GPU VFIO remains a provider-specific risk

## Repo Layout

```text
apps/
  host-api/
  host-web/
guest/
  windows-agent/
packages/
  catalog-core/
  runtime-sdk/
  shared-types/
```

## Local Commands

```bash
npm install
npm test
npm run build
```

Run the API:

```bash
npm run dev:api
```

Run the web UI:

```bash
npm run dev:web
```

The API defaults to `http://127.0.0.1:4000` and the Vite UI defaults to `http://127.0.0.1:5173`.

Useful host API routes:

- `GET /api/status`
- `GET /api/config`
- `PUT /api/config`
- `GET /api/diagnostics`
- `POST /api/runtime/start`
- `POST /api/runtime/attach-display`
- `POST /api/runtime/detach-display`
- `POST /api/runtime/recover`
- `POST /api/runtime/recover-session`
- `POST /api/runtime/probe-stream-host`
- `POST /api/runtime/stop`
- `POST /api/catalog/scan`
- `POST /api/sessions`
- `GET /api/simulation`
- `PUT /api/simulation`
- `GET /api/events`

## Next Steps

1. Harden the Windows guest agent so the existing prototype paths become reliable real integrations.
2. Replace the managed VM scaffold with libvirt/QEMU lifecycle control.
3. Complete the real Steam path and add Ubisoft Connect as the next launcher.
4. Add explicit Sunshine/Moonlight readiness and single-GPU recovery flows.
5. Decide whether configuration should stay file-based only or also gain a richer persisted state store.
