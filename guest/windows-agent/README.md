# Windows Agent Scaffold

This directory now contains a minimal .NET 10 guest-agent scaffold that matches the documented host/guest contract.

Current scaffold behavior:

- exposes `GET /health`, `POST /register`, `POST /scan`, `GET /games`, `GET /simulation`, `PUT /simulation`, `POST /stream-probe`, `POST /launch`, `POST /terminate`, and `GET /events`
- keeps in-memory guest status, catalog, sessions, and recent event history
- scans real Steam library manifests when they are present on Windows
- falls back to sample Steam data when no Windows Steam libraries are discovered
- scans early Ubisoft Connect install evidence from Windows registry uninstall entries and launcher data manifests
- falls back to sample Ubisoft data when no Windows Ubisoft installs are discovered
- attempts a real Steam handoff on Windows guests for Steam titles:
  - prefers `steam.exe -applaunch <appid>` when Steam can be resolved
  - falls back to `steam://run/<appid>` when only the Steam protocol path is available
  - fails fast with `session.failed` if the Steam handoff itself errors
- attempts lightweight real process observation for discovered Steam titles after handoff:
  - derives candidate `.exe` names from the discovered install root
  - uses observed Windows process names when available for `session.game.detected`
  - falls back to the existing simulated detect step when no candidate process is observed in time
- attempts early Sunshine stream-host observation after launch:
  - watches for a Sunshine process and common Sunshine listener ports on Windows
  - records stream-ready mode, detail, process name, and listener ports in game metadata when observed
  - falls back to the existing simulated stream-ready delay when Sunshine cannot be observed
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
  - adjust Sunshine probe process names and listener ports per game
- supports direct Sunshine stream-host probing without launching a game

What it does not do yet:

- run as a Windows service
- guarantee accurate per-title process detection for every Steam game shape
- guarantee complete Ubisoft Connect metadata across every launcher cache shape
- provide production-grade Sunshine/Moonlight readiness or client-attachment orchestration
- launch Ubisoft Connect games through the real launcher

Local run command on a machine with .NET 10 installed:

```powershell
dotnet run --project guest/windows-agent/GameVmHub.WindowsAgent.csproj
```

Default useful URLs:

- `http://127.0.0.1:5000/health`
- `http://127.0.0.1:5000/games`
- `http://127.0.0.1:5000/simulation`
- `http://127.0.0.1:5000/stream-probe`
- `http://127.0.0.1:5000/events`
