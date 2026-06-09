import { afterEach, describe, expect, it } from "vitest";
import type {
  GameRecord,
  GameSession,
  GuestAgentEventEnvelope,
  GuestAgentGameListResponse,
  GuestAgentHealthResponse,
  GuestAgentLaunchResponse,
  GuestAgentSimulationCatalogResponse,
  GuestStatusSnapshot,
  HostConfig,
  SessionEvent,
} from "@game-vm-hub/shared-types";
import { ManagedVmController } from "./managed-vm-controller.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createEventStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(nextController) {
      controller = nextController;
    },
    cancel() {
      controller = null;
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    }),
    emit(envelope: GuestAgentEventEnvelope) {
      controller?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`));
    },
    close() {
      controller?.close();
      controller = null;
    },
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await Promise.resolve();
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const config: HostConfig = {
  runtimeProvider: "managed-vm",
  managedVm: {
    vmName: "windows-vfio",
    guestAgentBaseUrl: "http://127.0.0.1:8765",
    streamMode: "sunshine-moonlight",
  },
  pinnedGameIds: [],
};

describe("ManagedVmController", () => {
  const streams: Array<ReturnType<typeof createEventStream>> = [];

  afterEach(() => {
    for (const stream of streams) {
      stream.close();
    }
    streams.length = 0;
  });

  it("connects to the guest agent and consumes the event stream during scan, launch, and terminate", async () => {
    const calls: Array<{ path: string; method: string; body: string | null }> = [];

    const games: GameRecord[] = [
      {
        id: "steam:app-400",
        title: "Portal",
        launcher: "steam",
        installState: "installed",
        launchCommandRef: "steam://run/400",
        lastSeenAt: "2026-06-06T10:00:00.000Z",
        compatibilityFlags: ["prototype"],
        guestMetadata: {
          installRoot: "C:\\Program Files (x86)\\Steam",
          launcherAppId: "400",
        },
      },
    ];

    const baseStatus: GuestStatusSnapshot = {
      guestPowerState: "running",
      agentState: "ready",
      streamHostState: "ready",
      scanState: "idle",
      warnings: [],
      connectedGuestName: "Windows Gaming VM",
    };

    const health: GuestAgentHealthResponse = {
      guestName: "Windows Gaming VM",
      agentVersion: "0.1.0",
      status: baseStatus,
    };

    const runningSession: GameSession = {
      id: "session-1",
      gameId: "steam:app-400",
      runtimeState: "running",
      guestState: "ready",
      streamState: "ready",
      startedAt: "2026-06-06T10:01:00.000Z",
    };

    const terminatedSession: GameSession = {
      ...runningSession,
      runtimeState: "terminated",
      endedAt: "2026-06-06T10:02:00.000Z",
      streamState: "unavailable",
    };

    const simulationCatalog: GuestAgentSimulationCatalogResponse = {
      games: [
        {
          gameId: "steam:app-400",
          outcome: "success",
          failureMessage: "Simulated launch failure for Portal.",
          launchAcceptedDelayMs: 250,
          gameDetectedDelayMs: 350,
          streamReadyDelayMs: 500,
        },
      ],
    };

    const stream = createEventStream();
    streams.push(stream);

    const emitEvent = (
      event: SessionEvent,
      statusPatch: Partial<GuestStatusSnapshot> = {},
    ) => {
      stream.emit({
        event,
        status: {
          ...baseStatus,
          ...statusPatch,
        },
      });
    };

    const controller = new ManagedVmController(config, {
      fetchImpl: async (input, init) => {
        const url =
          typeof input === "string"
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? init.body : null;

        calls.push({
          path: url.pathname,
          method,
          body,
        });

        if (url.pathname === "/health") {
          return jsonResponse(health);
        }

        if (url.pathname === "/events") {
          return stream.response;
        }

        if (url.pathname === "/scan") {
          emitEvent(
            {
              id: "event-scan-start",
              type: "guest.scan.started",
              level: "info",
              createdAt: "2026-06-06T10:00:10.000Z",
              message: "Guest launcher scan started.",
            },
            {
              agentState: "scanning",
              scanState: "running",
            },
          );

          emitEvent(
            {
              id: "event-scan-complete",
              type: "guest.scan.completed",
              level: "info",
              createdAt: "2026-06-06T10:00:20.000Z",
              message: "Guest launcher scan completed.",
            },
            {
              scanState: "complete",
            },
          );

          const response: GuestAgentGameListResponse = {
            games,
            scannedAt: "2026-06-06T10:00:30.000Z",
          };
          return jsonResponse(response);
        }

        if (url.pathname === "/simulation" && method === "GET") {
          return jsonResponse(simulationCatalog);
        }

        if (url.pathname === "/simulation" && method === "PUT") {
          simulationCatalog.games[0] = {
            ...simulationCatalog.games[0],
            ...(body ? JSON.parse(body) : {}),
          };
          return jsonResponse(simulationCatalog);
        }

        if (url.pathname === "/launch") {
          emitEvent(
            {
              id: "event-launch",
              type: "session.launch.started",
              level: "info",
              createdAt: "2026-06-06T10:01:00.000Z",
              message: "Launch accepted for Portal.",
              gameId: "steam:app-400",
              sessionId: "session-1",
            },
            {
              activeSessionId: "session-1",
            },
          );

          emitEvent(
            {
              id: "event-stream-ready",
              type: "session.streaming.ready",
              level: "info",
              createdAt: "2026-06-06T10:01:05.000Z",
              message: "Guest stream path is ready.",
              gameId: "steam:app-400",
              sessionId: "session-1",
            },
            {
              activeSessionId: "session-1",
            },
          );

          const response: GuestAgentLaunchResponse = {
            session: runningSession,
          };
          return jsonResponse(response);
        }

        if (url.pathname === "/terminate") {
          emitEvent(
            {
              id: "event-ended",
              type: "session.ended",
              level: "info",
              createdAt: "2026-06-06T10:02:00.000Z",
              message: "Guest session terminated.",
              gameId: "steam:app-400",
              sessionId: "session-1",
            },
            {
              streamHostState: "ready",
            },
          );

          return jsonResponse(terminatedSession);
        }

        return jsonResponse({ message: "Not found" }, 404);
      },
    });

    const status = await controller.runtimeProvider.startGuest();
    expect(status.guestPowerState).toBe("running");
    expect(status.connectedGuestName).toBe("Windows Gaming VM");

    const scannedGames = await controller.guestConnection.scanGames();
    await flushAsyncWork();
    expect(scannedGames).toEqual(games);

    const simulationProfiles = await controller.guestConnection.getSimulationCatalog();
    expect(simulationProfiles.games[0]?.outcome).toBe("success");

    const updatedProfiles = await controller.guestConnection.updateSimulation({
      gameId: "steam:app-400",
      outcome: "fail-before-stream-ready",
      failureMessage: "Portal failed before remote play became ready.",
      streamReadyDelayMs: 900,
      streamProbeProcessNames: ["sunshine", "sunshine-service"],
      streamProbePorts: [47984, 48010],
    });
    expect(updatedProfiles.games[0]).toMatchObject({
      gameId: "steam:app-400",
      outcome: "fail-before-stream-ready",
      failureMessage: "Portal failed before remote play became ready.",
      streamReadyDelayMs: 900,
      streamProbeProcessNames: ["sunshine", "sunshine-service"],
      streamProbePorts: [47984, 48010],
    });

    const launch = await controller.guestConnection.launchGame("steam:app-400");
    await flushAsyncWork();
    expect(launch.session.id).toBe("session-1");

    const attachResult = await controller.runtimeProvider.attachDisplay();
    expect(attachResult).toMatchObject({
      ok: true,
      detail: "Remote play path is ready. Attach Moonlight or another client to begin play.",
    });

    const detachResult = await controller.runtimeProvider.detachDisplay();
    expect(detachResult).toMatchObject({
      ok: true,
      detail: "Remote client detached. The stream path stays ready for another attachment.",
    });

    const terminated = await controller.guestConnection.terminateSession("session-1");
    await flushAsyncWork();
    expect(terminated?.runtimeState).toBe("terminated");

    const snapshot = controller.snapshot();
    expect(snapshot.games).toEqual(games);
    expect(snapshot.sessions[0]?.runtimeState).toBe("terminated");
    expect(snapshot.events.map((event) => event.type)).toEqual([
      "session.ended",
      "display.detached",
      "display.attached",
      "session.streaming.ready",
      "session.launch.started",
      "guest.scan.completed",
      "guest.scan.started",
      "guest.connected",
    ]);

    expect(calls).toEqual([
      { path: "/health", method: "GET", body: null },
      { path: "/events", method: "GET", body: null },
      { path: "/scan", method: "POST", body: null },
      { path: "/simulation", method: "GET", body: null },
      {
        path: "/simulation",
        method: "PUT",
        body: JSON.stringify({
          gameId: "steam:app-400",
          outcome: "fail-before-stream-ready",
          failureMessage: "Portal failed before remote play became ready.",
          streamReadyDelayMs: 900,
          streamProbeProcessNames: ["sunshine", "sunshine-service"],
          streamProbePorts: [47984, 48010],
        }),
      },
      { path: "/launch", method: "POST", body: JSON.stringify({ gameId: "steam:app-400" }) },
      { path: "/terminate", method: "POST", body: JSON.stringify({ sessionId: "session-1" }) },
    ]);

    expect(await controller.runtimeProvider.getDiagnostics()).toMatchObject({
      guestAgentReachable: true,
      eventStreamConnected: true,
      remotePlayReady: false,
      remoteClientAttached: false,
      activeSessionRunning: false,
      activeSessionStreamReady: false,
      connectedGuestName: "Windows Gaming VM",
      lastDisplayAttachDetail: "Remote display handoff cleared because the guest session ended.",
      sessionCount: 1,
    });
  });

  it("reports guest event stream availability problems in diagnostics", async () => {
    const health: GuestAgentHealthResponse = {
      guestName: "Windows Gaming VM",
      agentVersion: "0.1.0",
      status: {
        guestPowerState: "running",
        agentState: "ready",
        streamHostState: "preparing",
        scanState: "idle",
        warnings: [],
        connectedGuestName: "Windows Gaming VM",
      },
    };

    const controller = new ManagedVmController(config, {
      fetchImpl: async (input) => {
        const url =
          typeof input === "string"
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);

        if (url.pathname === "/health") {
          return jsonResponse(health);
        }

        if (url.pathname === "/events") {
          return jsonResponse({ message: "stream not available" }, 503);
        }

        return jsonResponse({ message: "Not found" }, 404);
      },
    });

    const status = await controller.runtimeProvider.startGuest();
    expect(status.guestPowerState).toBe("running");

    expect(await controller.runtimeProvider.getDiagnostics()).toMatchObject({
      guestAgentReachable: true,
      eventStreamConnected: false,
      eventStreamState: "reconnecting",
      eventStreamReconnectAttempts: 1,
      remotePlayReady: false,
      connectedGuestName: "Windows Gaming VM",
      sessionCount: 0,
    });
    expect((await controller.runtimeProvider.getDiagnostics()).lastEventStreamError).toContain(
      "stream not available",
    );
  });

  it("does not attach a remote client before the stream path is ready", async () => {
    const stream = createEventStream();
    streams.push(stream);

    const controller = new ManagedVmController(config, {
      fetchImpl: async (input) => {
        const url =
          typeof input === "string"
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);

        if (url.pathname === "/health") {
          return jsonResponse({
            guestName: "Windows Gaming VM",
            agentVersion: "0.1.0",
            status: {
              guestPowerState: "running",
              agentState: "ready",
              streamHostState: "preparing",
              scanState: "idle",
              warnings: [],
              connectedGuestName: "Windows Gaming VM",
            },
          } satisfies GuestAgentHealthResponse);
        }

        if (url.pathname === "/events") {
          return stream.response;
        }

        return jsonResponse({ message: "Not found" }, 404);
      },
    });

    await controller.runtimeProvider.startGuest();

    const attachResult = await controller.runtimeProvider.attachDisplay();
    const diagnostics = await controller.runtimeProvider.getDiagnostics();

    expect(attachResult).toMatchObject({
      ok: false,
      detail: "No stream-ready active session is available for remote display attachment.",
    });
    expect(diagnostics).toMatchObject({
      remotePlayReady: false,
      remoteClientAttached: false,
      activeSessionRunning: false,
      activeSessionStreamReady: false,
      lastDisplayAttachDetail:
        "No stream-ready active session is available for remote display attachment.",
    });
    expect(controller.snapshot().events[0]?.type).toBe("display.attach.failed");
  });

  it("does not detach a remote client when nothing is attached", async () => {
    const stream = createEventStream();
    streams.push(stream);

    const controller = new ManagedVmController(config, {
      fetchImpl: async (input) => {
        const url =
          typeof input === "string"
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);

        if (url.pathname === "/health") {
          return jsonResponse({
            guestName: "Windows Gaming VM",
            agentVersion: "0.1.0",
            status: {
              guestPowerState: "running",
              agentState: "ready",
              streamHostState: "ready",
              scanState: "idle",
              warnings: [],
              connectedGuestName: "Windows Gaming VM",
            },
          } satisfies GuestAgentHealthResponse);
        }

        if (url.pathname === "/events") {
          return stream.response;
        }

        return jsonResponse({ message: "Not found" }, 404);
      },
    });

    await controller.runtimeProvider.startGuest();

    const detachResult = await controller.runtimeProvider.detachDisplay();
    const diagnostics = await controller.runtimeProvider.getDiagnostics();

    expect(detachResult).toMatchObject({
      ok: false,
      detail: "No remote client is currently attached.",
    });
    expect(diagnostics).toMatchObject({
      remotePlayReady: false,
      remoteClientAttached: false,
      activeSessionRunning: false,
      activeSessionStreamReady: false,
      lastDisplayAttachDetail: "No remote client is currently attached.",
    });
    expect(controller.snapshot().events[0]?.type).toBe("display.detach.failed");
  });

  it("reconnects the guest event stream through prepare when the guest stays reachable", async () => {
    let streamAvailable = false;
    const stream = createEventStream();
    streams.push(stream);

    const controller = new ManagedVmController(config, {
      fetchImpl: async (input) => {
        const url =
          typeof input === "string"
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);

        if (url.pathname === "/health") {
          return jsonResponse({
            guestName: "Windows Gaming VM",
            agentVersion: "0.1.0",
            status: {
              guestPowerState: "running",
              agentState: "ready",
              streamHostState: "preparing",
              scanState: "idle",
              warnings: [],
              connectedGuestName: "Windows Gaming VM",
            },
          } satisfies GuestAgentHealthResponse);
        }

        if (url.pathname === "/events") {
          if (streamAvailable) {
            return stream.response;
          }

          return jsonResponse({ message: "stream not available" }, 503);
        }

        return jsonResponse({ message: "Not found" }, 404);
      },
    });

    await controller.runtimeProvider.startGuest();
    expect(await controller.runtimeProvider.getDiagnostics()).toMatchObject({
      guestAgentReachable: true,
      eventStreamConnected: false,
      eventStreamState: "reconnecting",
      eventStreamReconnectAttempts: 1,
    });

    streamAvailable = true;
    const recoveredStatus = await controller.runtimeProvider.prepare();
    await flushAsyncWork();

    expect(recoveredStatus.guestPowerState).toBe("running");
    expect(await controller.runtimeProvider.getDiagnostics()).toMatchObject({
      guestAgentReachable: true,
      eventStreamConnected: true,
      eventStreamState: "connected",
      eventStreamReconnectAttempts: 0,
      connectedGuestName: "Windows Gaming VM",
    });
  });

  it("automatically reconnects the guest event stream after an unexpected disconnect", async () => {
    const firstStream = createEventStream();
    const secondStream = createEventStream();
    streams.push(firstStream, secondStream);
    let eventStreamRequestCount = 0;

    const controller = new ManagedVmController(
      config,
      {
        eventStreamReconnectDelayMs: 5,
        fetchImpl: async (input) => {
          const url =
            typeof input === "string"
              ? new URL(input)
              : input instanceof URL
                ? input
                : new URL(input.url);

          if (url.pathname === "/health") {
            return jsonResponse({
              guestName: "Windows Gaming VM",
              agentVersion: "0.1.0",
              status: {
                guestPowerState: "running",
                agentState: "ready",
                streamHostState: "preparing",
                scanState: "idle",
                warnings: [],
                connectedGuestName: "Windows Gaming VM",
              },
            } satisfies GuestAgentHealthResponse);
          }

          if (url.pathname === "/events") {
            eventStreamRequestCount += 1;
            return eventStreamRequestCount === 1 ? firstStream.response : secondStream.response;
          }

          return jsonResponse({ message: "Not found" }, 404);
        },
      },
    );

    await controller.runtimeProvider.startGuest();

    firstStream.close();
    await sleep(60);

    const diagnostics = await controller.runtimeProvider.getDiagnostics();
    expect(diagnostics).toMatchObject({
      guestAgentReachable: true,
      eventStreamConnected: true,
      eventStreamState: "connected",
      eventStreamReconnectAttempts: 0,
      connectedGuestName: "Windows Gaming VM",
    });
    expect(eventStreamRequestCount).toBeGreaterThanOrEqual(2);

    secondStream.emit({
      event: {
        id: "event-after-reconnect",
        type: "guest.scan.started",
        level: "info",
        createdAt: "2026-06-08T12:00:00.000Z",
        message: "Guest launcher scan started after reconnect.",
      },
      status: {
        guestPowerState: "running",
        agentState: "scanning",
        streamHostState: "preparing",
        scanState: "running",
        warnings: [],
        connectedGuestName: "Windows Gaming VM",
      },
    });
    await flushAsyncWork();

    expect(controller.snapshot().events[0]).toMatchObject({
      id: "event-after-reconnect",
      type: "guest.scan.started",
      message: "Guest launcher scan started after reconnect.",
    });
  });

  it("flags a managed-vm launch as stalled when stream readiness exceeds the expected timing window", async () => {
    const stream = createEventStream();
    streams.push(stream);

    const controller = new ManagedVmController(config, {
      fetchImpl: async (input) => {
        const url =
          typeof input === "string"
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);

        if (url.pathname === "/health") {
          return jsonResponse({
            guestName: "Windows Gaming VM",
            agentVersion: "0.1.0",
            status: {
              guestPowerState: "running",
              agentState: "ready",
              streamHostState: "preparing",
              scanState: "idle",
              warnings: [],
              connectedGuestName: "Windows Gaming VM",
            },
          } satisfies GuestAgentHealthResponse);
        }

        if (url.pathname === "/events") {
          return stream.response;
        }

        if (url.pathname === "/scan") {
          return jsonResponse({
            games: [
              {
                id: "steam:app-400",
                title: "Portal",
                launcher: "steam",
                installState: "installed",
                launchCommandRef: "steam://run/400",
                lastSeenAt: "2026-06-08T12:00:00.000Z",
                compatibilityFlags: ["prototype"],
                guestMetadata: {
                  launchAcceptedDelayMs: "250",
                  gameDetectedDelayMs: "350",
                  streamReadyDelayMs: "500",
                },
              },
            ],
            scannedAt: "2026-06-08T12:00:01.000Z",
          } satisfies GuestAgentGameListResponse);
        }

        if (url.pathname === "/launch") {
          return jsonResponse({
            session: {
              id: "session-stalled",
              gameId: "steam:app-400",
              runtimeState: "launching",
              guestState: "online",
              streamState: "preparing",
              startedAt: new Date(Date.now() - 6000).toISOString(),
            },
          } satisfies GuestAgentLaunchResponse);
        }

        return jsonResponse({ message: "Not found" }, 404);
      },
    });

    await controller.runtimeProvider.startGuest();
    await controller.guestConnection.scanGames();
    await controller.guestConnection.launchGame("steam:app-400");

    const diagnostics = await controller.runtimeProvider.getDiagnostics();
    expect(diagnostics).toMatchObject({
      remotePlayReady: false,
      remotePlayStalled: true,
      activeSessionRunning: true,
      activeSessionStreamReady: false,
      activeSessionExpectedReadyMs: 1100,
    });
    expect(diagnostics.activeSessionAgeMs).toBeGreaterThanOrEqual(6000);
    expect(diagnostics.remotePlayStallDetail).toContain("expected readiness was around 1.1s");
  });

  it("updates the tracked session when the guest emits a failed launch lifecycle", async () => {
    const stream = createEventStream();
    streams.push(stream);

    const queuedSession: GameSession = {
      id: "session-failed",
      gameId: "ubisoft-connect:anno-1800",
      runtimeState: "queued",
      guestState: "online",
      streamState: "preparing",
      startedAt: "2026-06-07T09:10:00.000Z",
    };

    const controller = new ManagedVmController(config, {
      fetchImpl: async (input) => {
        const url =
          typeof input === "string"
            ? new URL(input)
            : input instanceof URL
              ? input
              : new URL(input.url);

        if (url.pathname === "/health") {
          return jsonResponse({
            guestName: "Windows Gaming VM",
            agentVersion: "0.1.0",
            status: {
              guestPowerState: "running",
              agentState: "ready",
              streamHostState: "preparing",
              scanState: "idle",
              warnings: [],
              connectedGuestName: "Windows Gaming VM",
            },
          } satisfies GuestAgentHealthResponse);
        }

        if (url.pathname === "/events") {
          return stream.response;
        }

        if (url.pathname === "/launch") {
          stream.emit({
            event: {
              id: "event-failed",
              type: "session.failed",
              level: "error",
              createdAt: "2026-06-07T09:10:02.000Z",
              message:
                "Sunshine stream handshake timed out before the game session became remotely playable.",
              gameId: "ubisoft-connect:anno-1800",
              sessionId: "session-failed",
            },
            status: {
              guestPowerState: "running",
              agentState: "error",
              streamHostState: "unavailable",
              scanState: "idle",
              warnings: [],
              connectedGuestName: "Windows Gaming VM",
            },
          });

          return jsonResponse({
            session: queuedSession,
          } satisfies GuestAgentLaunchResponse);
        }

        return jsonResponse({ message: "Not found" }, 404);
      },
    });

    await controller.runtimeProvider.startGuest();
    const launch = await controller.guestConnection.launchGame("ubisoft-connect:anno-1800");
    await flushAsyncWork();

    expect(launch.session.runtimeState).toBe("queued");

    const snapshot = controller.snapshot();
    expect(snapshot.sessions[0]).toMatchObject({
      id: "session-failed",
      runtimeState: "failed",
      guestState: "error",
      streamState: "unavailable",
      lastError:
        "Sunshine stream handshake timed out before the game session became remotely playable.",
    });

    expect(await controller.runtimeProvider.getDiagnostics()).toMatchObject({
      remotePlayReady: false,
      lastSessionError:
        "Sunshine stream handshake timed out before the game session became remotely playable.",
    });
  });
});
