# Windows Guest Agent Contract

The real Windows agent is not implemented yet, but the host-side contract is now defined so the fake provider can be replaced without changing the Linux app model.

## Expected Endpoints

- `GET /health`
  - returns guest identity, agent version, and current `GuestStatusSnapshot`
- `POST /register`
  - accepts `GuestAgentRegisterRequest`
  - guest announces itself to the host control plane
- `POST /scan`
  - triggers launcher scanning in the guest
  - returns `GuestAgentGameListResponse`
  - current scaffold attempts real Steam `appmanifest_*.acf` discovery first and falls back to sample Steam data if no Windows Steam library is found
- `GET /games`
  - returns `GuestAgentGameListResponse`
- `GET /simulation`
  - returns the current scaffolded launch simulation settings per game
- `PUT /simulation`
  - updates scaffolded launch simulation settings per game
- `POST /launch`
  - accepts `GuestAgentLaunchRequest`
  - returns `GuestAgentLaunchResponse`
  - current scaffold attempts a real Steam handoff for Steam titles on Windows before continuing the staged lifecycle model
- `POST /terminate`
  - accepts `GuestAgentTerminateRequest`
  - terminates the active session by session id
- `GET /events`
  - streams `GuestAgentEventEnvelope` messages
  - current scaffold uses Server-Sent Events

## Required Behavior

- normalize launcher-specific installs to stable `GameRecord` ids
- report scan status transitions and launch lifecycle events
- keep the host informed of the active session id
- provide actionable error messages instead of generic failures
- launch responses do not need to imply that streaming is already ready:
  - the guest may return a queued or preparing session first
  - `GET /events` is the source of truth for later launch, process-detected, and stream-ready transitions
- a launch may still fail immediately if the guest cannot hand off the request to the real launcher process
- launch failures may also arrive asynchronously through `GET /events` after an initially accepted launch response

## Current Host Assumptions

- default guest base URL: `http://127.0.0.1:8765`
- preferred display path: Sunshine in guest, Moonlight on host
- first real launcher scope: Steam, then Ubisoft Connect
