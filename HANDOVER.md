# Game VM Hub Handover

Last updated: 2026-06-07

## Goal

Track the setup, design decisions, experiments, and next actions for the Game VM Hub project.

## Workflow Instruction

- Treat `HANDOVER.md` as mandatory project memory.
- Update this file after every relevant code change, architecture decision, prototype result, test run, or blocker.
- Record what changed, what was verified, and what remains open so a later session can continue without re-discovery.
- Keep Git updated with local commits and remote pushes when a meaningful checkpoint or risky transition justifies it.
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
- A single-GPU path remains acceptable for this machine if the control plane is treated as remote-first and gameplay happens through guest streaming rather than the Linux host display.

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
- The managed-VM path now assumes guest-agent HTTP integration can progress ahead of full libvirt/QEMU lifecycle automation.
- The preferred near-term deployment model is now single-GPU passthrough with remote play:
  - Linux host starts and manages the VM
  - Windows guest owns the GPU during play
  - Sunshine runs in the guest
  - Moonlight on an Android box or another remote client is the primary play surface
  - the host web UI should remain usable remotely rather than assuming a live local Linux monitor
- Git is now initialized locally on branch `main` with user identity configured as `josvv80 <jos@uwbs.nl>`.
- Sudo and SSH-related credentials must not be written into `HANDOVER.md`, committed into Git, or stored in project files.
- GitHub SSH is configured to use a dedicated key at `/home/jos/.ssh/id_ed25519_github` rather than reusing a server key.

## Open Actions

- Replace the guest-agent scaffold data sources with real Windows launcher/process integration.
- Replace the managed VM scaffold with real libvirt/QEMU lifecycle control and guest-agent event consumption.
- Harden the guest registration and event contract for reconnect and error cases.
- Implement real Steam discovery and launch execution.
- Add explicit remote-play lifecycle handling for the single-GPU path:
  - stream-ready signaling
  - guest unreachable / handoff failure diagnostics
  - recovery after guest stop or VM failure
- Keep the UI and host API biased toward remote administration rather than requiring the host display during guest runtime.

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
- Fixed `/home/jos/.ssh` ownership so the local user can manage SSH keys normally.
- Created a dedicated GitHub SSH keypair:
  - private key path: `/home/jos/.ssh/id_ed25519_github`
  - public key path: `/home/jos/.ssh/id_ed25519_github.pub`
- Added a `github.com` SSH config entry that points to `/home/jos/.ssh/id_ed25519_github`.
- Configured Git remote:
  - `origin` -> `git@github.com:josvv80/Linux-game-vm-app.git`
- Added the GitHub public key to the `josvv80` GitHub account and verified SSH auth with:
  - `ssh -T git@github.com`
- Repaired broken system SSH ownership that was blocking normal Git SSH usage:
  - changed `/etc/ssh/ssh_config`, `/etc/ssh/ssh_config.d`, and `/usr/lib/systemd/ssh_config.d/20-systemd-ssh-proxy.conf` back to `root:root`
- Verified the repo can reach GitHub normally with:
  - `git ls-remote origin HEAD`
- Added a real managed-VM HTTP contract path in `packages/runtime-sdk/src/managed-vm-controller.ts`:
  - health probes via `GET /health`
  - catalog scans via `POST /scan`
  - launch requests via `POST /launch`
  - termination via `POST /terminate`
- Added runtime-sdk coverage for the managed-VM contract path in `packages/runtime-sdk/src/managed-vm-controller.test.ts`.
- Added a .NET 10 Windows guest-agent scaffold in `guest/windows-agent`:
  - `GameVmHub.WindowsAgent.csproj`
  - `Program.cs`
  - in-memory sample catalog and session state
  - Server-Sent Events stream at `GET /events`
- Updated `guest/windows-agent/README.md` and `guest/windows-agent/CONTRACT.md` to match the scaffolded endpoint behavior.
- Retargeted the guest-agent scaffold from `net8.0` to `net10.0` because this Ubuntu 26.04 machine exposes `dotnet-sdk-10.0` in apt and not `dotnet-sdk-8.0`.
- Verified local .NET SDK availability on the Linux host:
  - `dotnet --info` shows SDK `10.0.108` on Ubuntu 26.04
- Verified the guest-agent scaffold builds successfully with:
  - `env DOTNET_CLI_HOME=/tmp dotnet build guest/windows-agent/GameVmHub.WindowsAgent.csproj`
- Noted an environment constraint for future Codex sessions:
  - plain `dotnet build` initially failed because first-run setup tried to write under `/home/jos/.dotnet`, which is outside this session's writable paths
- Extended `packages/runtime-sdk/src/managed-vm-controller.ts` to consume the guest `GET /events` SSE stream:
  - opens the stream after successful `GET /health`
  - folds remote event envelopes into the host snapshot/event timeline
  - suppresses duplicate locally synthesized scan/launch/end events while the remote stream is active
- Reworked `packages/runtime-sdk/src/managed-vm-controller.test.ts` to cover the stream-backed managed-VM path instead of request/response calls only.
- Verified after the stream integration:
  - `npm test` passed
  - `npm run build` passed
- Added `.gitignore` entries for `.NET` build outputs:
  - `bin/`
  - `obj/`
- Pushed backup branch to GitHub before reconciling `main`:
  - `origin/codex-checkpoint-2026-06-06`
- Began non-destructive reconciliation of local `main` with `origin/main`:
  - fetched the unrelated remote root commit
  - merged with `--allow-unrelated-histories`
  - resolved the `README.md` add/add conflict in favor of the current project README
- Completed GitHub branch reconciliation:
  - created merge commit `9ef072b` (`Merge origin/main into project history`)
  - pushed the reconciled history to `origin/main`
  - preserved the earlier backup at `origin/codex-checkpoint-2026-06-06`
- Added an explicit workflow instruction to keep Git updated with commits/pushes when a meaningful checkpoint or risky transition justifies it.
- Added a host API runtime-controller injection seam:
  - `apps/host-api/src/runtime-controller-factory.ts` now exports `RuntimeControllerFactory`
  - `apps/host-api/src/state.ts` accepts an injected runtime-controller factory for tests and future alternate boot paths
- Extended `apps/host-api/src/create-app.test.ts` with managed-VM app-layer coverage:
  - mocks guest `GET /health`
  - mocks guest `GET /events` SSE stream
  - exercises host `POST /api/runtime/start`
  - exercises host `POST /api/catalog/scan`
  - exercises host `POST /api/sessions`
  - exercises host `POST /api/sessions/:id/terminate`
  - verifies the host app drives the expected guest-agent HTTP contract
- Verified after the host API managed-VM test addition:
  - `npm test` passed
  - `npm run build` passed

### 2026-06-07

- Updated the project plan for the confirmed single-GPU deployment direction:
  - treat the Linux host as a remote-manageable control plane
  - assume the GPU is handed fully to the Windows guest during play
  - treat Sunshine-in-guest and Moonlight-on-Android-box as the preferred play flow
- Elevated remote-friendly lifecycle and recovery handling in the open actions so future implementation work does not assume a usable local Linux display while the VM is active.
- Added explicit remote-play diagnostics to `packages/shared-types/src/index.ts` via `RuntimeDiagnostics` fields for:
  - guest-agent reachability
  - guest event-stream connection state
  - remote-play readiness
  - connected guest name
  - last guest-agent, event-stream, and scan errors
- Extended `packages/runtime-sdk/src/managed-vm-controller.ts` to track managed-VM diagnostic state directly instead of relying on warning strings alone.
- Extended `packages/runtime-sdk/src/fake-environment.ts` so the fake provider also returns the richer diagnostics shape expected by the UI.
- Extended `packages/runtime-sdk/src/managed-vm-controller.test.ts` to verify:
  - diagnostics during a healthy managed-VM session
  - diagnostics when guest health succeeds but `GET /events` is unavailable
- Extended `apps/host-api/src/create-app.test.ts` so the managed-VM app-layer test also asserts `GET /api/diagnostics`.
- Updated `apps/host-web/src/App.tsx` and `apps/host-web/src/styles.css` to surface remote-play diagnostics in the dashboard:
  - guest agent reachable/offline
  - event-stream connected/not connected
  - remote-play ready/waiting
  - last known failure detail
  - connected guest name in the contract card
- Verified after the diagnostics UI and runtime update:
  - `npm test` passed
  - `npm run build` passed
- Extended `packages/runtime-sdk/src/managed-vm-controller.ts` with an explicit reconnect path:
  - `prepare()` now refreshes guest health and retries the guest `GET /events` stream
  - actions that run while the guest is already reachable now also retry the event stream if it is disconnected
  - an unexpectedly ended event stream is now treated as a recoverable disconnect instead of being silently accepted
- Added managed-VM recovery coverage:
  - `packages/runtime-sdk/src/managed-vm-controller.test.ts` now verifies that `prepare()` reconnects the event stream after an initial `GET /events` failure
  - `apps/host-api/src/create-app.test.ts` now verifies `POST /api/runtime/recover` through the host API
- Added explicit recovery plumbing in the host app:
  - `apps/host-api/src/state.ts` now exposes `prepareRuntime()`
  - `apps/host-api/src/create-app.ts` now exposes `POST /api/runtime/recover`
  - `apps/host-web/src/App.tsx` now shows a `Recover link` action when the guest is reachable but the event stream is disconnected
- Verified after the recovery path update:
  - `npm test` passed
  - `npm run build` passed
- Improved degraded-state operator guidance in the web UI:
  - `apps/host-web/src/App.tsx` now derives a remote-play recovery state for managed-VM mode
  - added a top-level recovery banner for:
    - guest agent offline
    - control link degraded
    - remote play not ready
    - remote play ready
  - the banner now gives context-specific action guidance instead of relying on raw diagnostics text alone
- Updated `apps/host-web/src/styles.css` with dedicated styling for the recovery banner and success state messaging.
- Verified after the degraded-state UI update:
  - `npm test` passed
  - `npm run build` passed
- Improved the Windows guest scaffold launch realism in `guest/windows-agent/Program.cs`:
  - launch now returns an initial queued session instead of immediately claiming stream readiness
  - background lifecycle events now progress through:
    - `session.launch.requested`
    - `session.launch.started`
    - `session.game.detected`
    - `session.streaming.ready`
  - guest status now starts closer to a real remote-play boot path:
    - agent online
    - stream unavailable until the staged launch flow reaches ready
  - guest launch lifecycles are now cancellable when a session is terminated
- Updated `guest/windows-agent/CONTRACT.md` and `guest/windows-agent/README.md` to document that launch responses may be queued/preparing and that `GET /events` is the source of truth for later readiness transitions.
- Verified after the guest scaffold lifecycle update:
  - `env DOTNET_CLI_HOME=/tmp dotnet build guest/windows-agent/GameVmHub.WindowsAgent.csproj` passed
- Added a guest-side simulated failure path in `guest/windows-agent/Program.cs`:
  - the scaffolded `Anno 1800` sample now fails before stream readiness
  - the guest emits `session.failed` as an asynchronous SSE event after an initially accepted launch
  - failed sessions now set `runtimeState=failed`, `guestState=error`, `streamState=unavailable`, and `lastError`
- Updated `guest/windows-agent/CONTRACT.md` and `guest/windows-agent/README.md` to document that launch failures may also arrive asynchronously after the initial launch response.
- Verified after the guest scaffold failure-path update:
  - `env DOTNET_CLI_HOME=/tmp dotnet build guest/windows-agent/GameVmHub.WindowsAgent.csproj` passed
- Extended `packages/runtime-sdk/src/managed-vm-controller.ts` to apply guest session lifecycle events to tracked sessions instead of treating them as timeline-only messages:
  - `session.launch.started`
  - `session.game.detected`
  - `session.streaming.ready`
  - `session.ended`
  - `session.failed`
- Added a queue for guest session events that arrive before the corresponding launch response session exists, so the managed-VM host model now handles real event/response races correctly.
- Extended diagnostics with `lastSessionError` in `packages/shared-types/src/index.ts` and surfaced guest-side session failure state through the host model.
- Extended verification:
  - `packages/runtime-sdk/src/managed-vm-controller.test.ts` now covers a failed managed-VM launch lifecycle
  - `apps/host-api/src/create-app.test.ts` now verifies that a guest-side failed launch is visible through `/api/sessions` and `/api/diagnostics`
  - `apps/host-web/src/App.tsx` now treats a failed latest session as a first-class recovery state in the banner logic
- Verified after the host-side failed-session propagation update:
  - `npm test` passed
  - `npm run build` passed
- Extended the Windows guest scaffold with explicit simulation controls:
  - `GET /simulation` now returns per-game launch simulation settings
  - `PUT /simulation` now updates per-game launch outcome and delay settings
  - simulation settings now persist in memory independently from the scanned catalog and are re-applied on future scans
- The guest scaffold can now simulate:
  - successful staged launches
  - failed-before-stream-ready launches
  - slower launch, detect, and stream-ready timings without code edits
- Updated `guest/windows-agent/CONTRACT.md` and `guest/windows-agent/README.md` to document the new simulation endpoints and usage.
- Verified after the guest simulation-controls update:
  - `env DOTNET_CLI_HOME=/tmp dotnet build guest/windows-agent/GameVmHub.WindowsAgent.csproj` passed
- Exposed guest simulation controls through the shared host contract:
  - `packages/shared-types/src/index.ts` now defines simulation outcome, catalog, profile, and update-request types
  - `GuestConnection` now supports simulation catalog reads and updates
- Extended both runtime providers with simulation-catalog support:
  - `packages/runtime-sdk/src/managed-vm-controller.ts` now proxies guest `GET /simulation` and `PUT /simulation`
  - `packages/runtime-sdk/src/fake-environment.ts` now keeps in-memory simulation profiles so the host API contract stays consistent across providers
- Extended the host API with simulation routes:
  - `apps/host-api/src/state.ts` now exposes simulation catalog read/update methods
  - `apps/host-api/src/create-app.ts` now serves `GET /api/simulation` and `PUT /api/simulation`
- Extended coverage for the simulation-control path:
  - `packages/runtime-sdk/src/managed-vm-controller.test.ts` now verifies managed-VM simulation reads and writes
  - `apps/host-api/src/create-app.test.ts` now verifies `GET /api/simulation` and `PUT /api/simulation` through the host API
- Updated the web dashboard to drive guest simulation scenarios directly:
  - `apps/host-web/src/App.tsx` now loads managed-VM simulation profiles only when the guest is reachable
  - the UI now exposes per-game outcome and delay controls plus guest-side failure-message editing
  - `apps/host-web/src/styles.css` now includes layout/styling for the simulation panel
- Verified after the host-side simulation-control update:
  - `npm run test --workspace @game-vm-hub/host-api` passed
  - `npm test` passed
  - `npm run build` passed
  - `env DOTNET_CLI_HOME=/tmp dotnet build guest/windows-agent/GameVmHub.WindowsAgent.csproj` passed
- Replaced the guest agent's Steam-only sample scan path with a first real discovery pass:
  - added `guest/windows-agent/SteamLibraryScanner.cs`
  - `POST /scan` now attempts to discover installed Steam titles from Windows `libraryfolders.vdf` and `appmanifest_*.acf`
  - discovered Steam titles are normalized to stable `steam:app-<appid>` ids with real install-root and manifest metadata
  - if no Windows Steam library is found, the guest falls back to sample Steam data instead of returning an empty catalog
  - sample Ubisoft data remains in the catalog because Ubisoft Connect discovery is still not implemented
- Extended guest simulation-profile behavior so newly discovered Steam titles also get editable simulation profiles instead of only the hard-coded sample entries.
- Updated `guest/windows-agent/README.md` and `guest/windows-agent/CONTRACT.md` to document the new mixed real-scan plus sample-fallback behavior.
- Verified after the guest Steam discovery update:
  - `env DOTNET_CLI_HOME=/tmp dotnet build guest/windows-agent/GameVmHub.WindowsAgent.csproj` passed
