# Game VM Hub

Game VM Hub is a local Linux-hosted control app for managing and launching PC games that run inside a Windows gaming environment.

## Goal

Provide a WinBoat-like control surface for PC games:

- browse a library in a local web UI
- see installed launchers and games in one place
- launch a selected game into a Windows gaming environment
- eventually support controller-friendly full-screen use

## Core Idea

This project does not try to make all Windows games run natively on Linux.
Instead, Linux acts as the host and control plane, while the games run inside a Windows VM or other Windows runtime.

## Current Implementation

The current repo implements the first vertical slice of the host-side control plane:

- npm workspaces monorepo with `apps/*` and `packages/*`
- shared TypeScript contracts for games, sessions, runtime state, and dashboard messages
- `catalog-core` domain helpers for game merging, launch eligibility, and session ordering
- `runtime-sdk` fake Windows guest/runtime provider that simulates:
  - guest boot
  - launcher scan
  - game launch
  - stream-ready transition
  - session termination
- managed VM provider scaffold that preserves the runtime interface and surfaces not-yet-implemented VM/guest actions cleanly
- `host-api` Fastify server with REST and WebSocket updates
- `host-web` React/Vite dashboard for:
  - runtime controls
  - provider and guest configuration
  - game catalog browsing
  - launch actions
  - session timeline visibility

This slice is intentionally fake on the runtime side so the host control plane can be validated before real VM/VFIO automation and the Windows agent are built.

## Chosen Direction

- Linux host app:
  - browser-first React UI
  - local Fastify API
  - TypeScript across the host stack
  - persisted host config in `data/host-config.json` once saved from the UI or API
- Windows guest:
  - planned .NET service/agent
  - Steam plus Ubisoft Connect as the first real launcher scope
  - host/guest contract documented in `guest/windows-agent/CONTRACT.md`
- VM/runtime layer:
  - long-term direction remains KVM/QEMU with VFIO GPU passthrough
  - current machine only shows one discrete AMD GPU, so single-GPU VFIO must be treated as a risky provider-specific path
- display/input path:
  - first playable target is Sunshine in the guest and Moonlight on the host

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
- `POST /api/runtime/start`
- `POST /api/runtime/stop`
- `POST /api/catalog/scan`
- `POST /api/sessions`
- `GET /api/events`

## Next Steps

1. Implement the real Windows guest agent behind the documented contract in `guest/windows-agent/CONTRACT.md`.
2. Replace the managed VM scaffold with libvirt/QEMU lifecycle control and guest-agent HTTP communication.
3. Implement the real Steam integration and one additional launcher.
4. Add diagnostics and recovery flows for the eventual single-GPU VFIO provider.
5. Decide whether configuration should stay file-based only or also gain a richer persisted state store.
