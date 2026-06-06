import { afterEach, describe, expect, it } from "vitest";
import type {
  GameRecord,
  GameSession,
  GuestAgentEventEnvelope,
  GuestAgentGameListResponse,
  GuestAgentHealthResponse,
  GuestAgentLaunchResponse,
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

const config: HostConfig = {
  runtimeProvider: "managed-vm",
  managedVm: {
    vmName: "windows-vfio",
    guestAgentBaseUrl: "http://127.0.0.1:8765",
    streamMode: "sunshine-moonlight",
  },
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

    const launch = await controller.guestConnection.launchGame("steam:app-400");
    await flushAsyncWork();
    expect(launch.session.id).toBe("session-1");

    const terminated = await controller.guestConnection.terminateSession("session-1");
    await flushAsyncWork();
    expect(terminated?.runtimeState).toBe("terminated");

    const snapshot = controller.snapshot();
    expect(snapshot.games).toEqual(games);
    expect(snapshot.sessions[0]?.runtimeState).toBe("terminated");
    expect(snapshot.events.map((event) => event.type)).toEqual([
      "session.ended",
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
      { path: "/launch", method: "POST", body: JSON.stringify({ gameId: "steam:app-400" }) },
      { path: "/terminate", method: "POST", body: JSON.stringify({ sessionId: "session-1" }) },
    ]);
  });
});
