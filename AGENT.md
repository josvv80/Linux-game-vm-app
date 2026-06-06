# Game VM Hub Agent Instructions

## Scope

These instructions apply to work inside `/home/jos/Desktop/PC Control/game-vm-hub`.

## Mission

Build a practical local app that lets the user browse and launch PC games from Linux while the games themselves run inside a Windows environment.

## Working Principles

- Treat this as a systems project, not just a UI project.
- Separate control-plane concerns from runtime concerns.
- Do not claim universal compatibility without evidence.
- Prefer end-to-end prototypes over speculative architecture.
- Keep the user experience simple even when the internals are complex.

## Expected Project Shape

Work should generally move toward these layers:

- host control app on Linux
- guest agent inside Windows
- runtime integration for VM lifecycle, storage, display, and input
- game catalog and launcher integration

## Documentation Rules

- Update `game-vm-hub/HANDOVER.md` after every relevant design decision, configuration change, prototype, test, or blocker.
- Record concrete file paths, commands, and observed behavior.
- Keep open actions visible until they are resolved.

## Engineering Rules

- Start with a minimal working slice.
- Prefer reversible experiments.
- For VM and passthrough work, document assumptions before changing host configuration.
- Treat performance, controller support, audio, storage I/O, and display latency as first-class concerns.

## First MVP Target

The first meaningful milestone should prove all of the following:

- Linux host can show a local game catalog UI
- host can talk to a Windows guest agent
- user can launch one game from the Linux UI
- the launched game is observable as running in the Windows environment

## Out Of Scope Until Proven Otherwise

- universal anti-cheat support
- automated support for every launcher
- one-click production-grade VFIO setup
- broad claims that all Windows games will work

## If You Are Continuing This Project Later

- Read `game-vm-hub/HANDOVER.md` first.
- Preserve the distinction between prototype assumptions and verified behavior.
- If you change scope, record the reason in the handover immediately.
