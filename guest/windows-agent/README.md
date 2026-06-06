# Windows Agent Scaffold

The full .NET guest agent is planned but not implemented in this Linux-only slice.

This directory is reserved for:

- Windows service bootstrap
- launcher scanners
- launch executor
- process/session watcher
- Sunshine status adapter

Current host-side implementation uses a fake guest/runtime provider so the Linux control plane can be exercised end to end before the real Windows service is built.
