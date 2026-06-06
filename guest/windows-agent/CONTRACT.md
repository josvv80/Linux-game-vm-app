# Windows Guest Agent Contract

The real Windows agent is not implemented yet, but the host-side contract is now defined so the fake provider can be replaced without changing the Linux app model.

## Expected Endpoints

- `GET /health`
  - returns guest identity, agent version, and current `GuestStatusSnapshot`
- `POST /register`
  - guest announces itself to the host control plane
- `POST /scan`
  - triggers launcher scanning in the guest
- `GET /games`
  - returns normalized `GameRecord[]`
- `POST /launch`
  - accepts `GuestAgentLaunchRequest`
  - returns `GuestAgentLaunchResponse`
- `POST /terminate`
  - terminates the active session by session id
- `GET /events`
  - streams `GuestAgentEventEnvelope` messages

## Required Behavior

- normalize launcher-specific installs to stable `GameRecord` ids
- report scan status transitions and launch lifecycle events
- keep the host informed of the active session id
- provide actionable error messages instead of generic failures

## Current Host Assumptions

- default guest base URL: `http://127.0.0.1:8765`
- preferred display path: Sunshine in guest, Moonlight on host
- first real launcher scope: Steam, then Ubisoft Connect
