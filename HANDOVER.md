# Game VM Hub Handover

Last updated: 2026-06-06

## Goal

Track the setup, design decisions, experiments, and next actions for the Game VM Hub project.

## Workflow Instruction

- Treat `HANDOVER.md` as mandatory project memory.
- Update this file after every relevant code change, architecture decision, prototype result, test run, or blocker.
- Record what changed, what was verified, and what remains open so a later session can continue without re-discovery.
- Do not store secrets in this file or anywhere else in the repo. This includes sudo passwords, API keys, tokens, private SSH keys, and credential material. Enter sensitive credentials interactively or keep them in a dedicated secret manager outside the project tree.

## Project Summary

Game VM Hub is intended to be a Linux-hosted control app for browsing and launching PC games that run inside a Windows environment.

The current working assumption is:

- Linux is the host and orchestration layer
- Windows is the primary game runtime
- the user experience should feel closer to an appliance than to a manual VM workflow

## Current Assumptions

- The best long-term technical direction is likely a Windows VM with GPU passthrough.
- A lighter early prototype may be useful before attempting full VFIO automation.
- Storage design matters early; game installs may need dedicated passthrough storage rather than simple shared folders.
- Anti-cheat and VM detection must be treated as compatibility risks, not ignored.
- This machine currently shows AMD-V support, 32 GiB RAM, and one visible discrete AMD GPU, so single-GPU VFIO should be treated as a provider-specific risk rather than as a control-plane default.

## Decisions

- A separate project folder was created under `/home/jos/Desktop/PC Control/game-vm-hub`.
- This project keeps its own `HANDOVER.md` and `AGENT.md`.
- A lowercase `agent.md` compatibility file points to `AGENT.md` so both naming conventions are covered.
- The project starts as an architecture and prototype effort, not as a promise of universal game compatibility.
- The host stack is now TypeScript fullstack: React/Vite browser UI plus Fastify API.
- The first implemented slice is browser-first and admin-first, not couch-first.
- The current runtime provider is intentionally fake so the host control plane can be exercised before real VM and Windows-agent integration.
- The first real launcher targets remain Steam first and Ubisoft Connect second.
- Runtime-provider selection is now an explicit host config concern instead of being hard-coded.
- Host configuration is persisted to `data/host-config.json` when saved through the UI or API.
- The real Windows guest contract is now documented in `guest/windows-agent/CONTRACT.md`.
- Git is now initialized locally on branch `main` with user identity configured as `josvv80 <jos@uwbs.nl>`.
- Sudo and SSH-related credentials must not be written into `HANDOVER.md`, committed into Git, or stored in project files.
- GitHub SSH is configured to use a dedicated key at `/home/jos/.ssh/id_ed25519_github` rather than reusing a server key.

## Open Actions

- Build the real Windows guest agent in `guest/windows-agent`.
- Replace the fake runtime provider with a managed Windows VM provider.
- Define the real guest registration and event contract.
- Implement real Steam discovery and launch execution.
- Decide how far to push single-GPU VFIO automation on this machine versus deferring it behind a safer managed-VM provider.

## Change Log

### 2026-06-06

- Initial project scaffold created.
- Added project-local `HANDOVER.md`.
- Added project-local `AGENT.md`.
- Added lowercase `agent.md` compatibility pointer to `AGENT.md`.
- Added `README.md` with initial scope, architecture direction, and next steps.
- Persistent bash alias `gamevm` added via `/home/jos/.bash_aliases` so the project folder can be opened quickly from the terminal.
- Added explicit workflow instruction that `HANDOVER.md` must be updated after every relevant implementation change, decision, test, or blocker.
- Confirmed local hardware baseline for planning:
  - AMD Ryzen 5 3600X
  - 32 GiB RAM
  - AMD-V available
  - one visible discrete AMD Navi 32 GPU
- Implemented the first host-side monorepo scaffold:
  - `packages/shared-types`
  - `packages/catalog-core`
  - `packages/runtime-sdk`
  - `apps/host-api`
  - `apps/host-web`
  - `guest/windows-agent/README.md` placeholder for the future real agent
- Added a fake runtime/guest provider that simulates guest boot, launcher scan, game launch, stream-ready, and session termination.
- Added a Fastify host API with REST endpoints and WebSocket dashboard updates.
- Added a React/Vite dashboard that can start the fake guest, scan the fake catalog, launch fake sessions, and display the event timeline.
- Added workspace tests covering catalog logic, fake runtime lifecycle, and host API endpoints.
- Verified commands and outcomes:
  - `npm install` completed successfully after switching local package references to version-based workspace links compatible with the available npm version.
  - `npm test` passed.
  - `npm run build` passed.
- Known current limitation:
  - the Windows agent is not implemented yet
  - the runtime provider is still fake
  - no real VM, VFIO, or Sunshine/Moonlight orchestration exists in code yet
- Added persisted host config support and host API/UI wiring for:
  - selecting `fake` vs `managed-vm` provider
  - storing VM name
  - storing guest agent base URL
- Added a managed VM controller scaffold in `packages/runtime-sdk/src/managed-vm-controller.ts`.
- Added the host-side runtime controller factory in `apps/host-api/src/runtime-controller-factory.ts` so provider choice can swap implementations without changing the API routes.
- Added a guest-agent contract document in `guest/windows-agent/CONTRACT.md` to lock the expected host/guest interface before building the Windows service.
- Extended verification with host API config persistence coverage:
  - `PUT /api/config` now has a test proving file persistence and provider switching behavior.
- Initialized a local Git repository successfully with `git init -b main`.
- Current Git state after initialization:
  - branch: `main`
  - no remote configured yet
- Fixed `/home/jos/.ssh` ownership so the local user can manage SSH keys normally.
- Created a dedicated GitHub SSH keypair:
  - private key path: `/home/jos/.ssh/id_ed25519_github`
  - public key path: `/home/jos/.ssh/id_ed25519_github.pub`
- Added a `github.com` SSH config entry that points to `/home/jos/.ssh/id_ed25519_github`.
- Configured Git remote:
  - `origin` -> `git@github.com:josvv80/Linux-game-vm-app.git`
- Remaining GitHub SSH step:
  - add the public key from `/home/jos/.ssh/id_ed25519_github.pub` to the GitHub account before testing/pushing
