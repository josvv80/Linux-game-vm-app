# Windows Agent Scaffold

This directory now contains a minimal .NET 10 guest-agent scaffold that matches the documented host/guest contract.

Current scaffold behavior:

- exposes `GET /health`, `POST /register`, `POST /scan`, `GET /games`, `GET /simulation`, `PUT /simulation`, `POST /launch`, `POST /terminate`, and `GET /events`
- keeps in-memory guest status, catalog, sessions, and recent event history
- scans real Steam library manifests when they are present on Windows
- falls back to sample Steam data when no Windows Steam libraries are discovered
- still serves sample Ubisoft data because Ubisoft Connect discovery is not implemented yet
- attempts a real Steam handoff on Windows guests for Steam titles:
  - prefers `steam.exe -applaunch <appid>` when Steam can be resolved
  - falls back to `steam://run/<appid>` when only the Steam protocol path is available
  - fails fast with `session.failed` if the Steam handoff itself errors
- streams event envelopes over Server-Sent Events from `GET /events`
- simulates a staged launch lifecycle:
  - launch queued
  - launcher accepted
  - game detected
  - stream ready
- includes one intentional sample failure path:
  - the scaffolded `Anno 1800` entry fails before stream readiness so host recovery and failure UI can be exercised
- supports simulation control without code edits:
  - switch a game between success and failure behavior
  - adjust launch, detect, and stream-ready delays per game

What it does not do yet:

- run as a Windows service
- watch real game processes after the Steam handoff
- inspect Sunshine readiness from the Windows guest
- scan real Ubisoft Connect installs

Local run command on a machine with .NET 10 installed:

```powershell
dotnet run --project guest/windows-agent/GameVmHub.WindowsAgent.csproj
```

Default useful URLs:

- `http://127.0.0.1:5000/health`
- `http://127.0.0.1:5000/games`
- `http://127.0.0.1:5000/simulation`
- `http://127.0.0.1:5000/events`
