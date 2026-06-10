import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./create-app.js";
import { AppState } from "./state.js";
import { ConfigStore, defaultHostConfig } from "./config-store.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
import { ManagedVmController } from "@game-vm-hub/runtime-sdk";

const apps: Array<ReturnType<typeof buildApp>> = [];

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

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
});

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("host API", () => {
  it("boots the fake guest and returns status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    await mkdir(dir, { recursive: true });
    const app = buildApp(
      new AppState(new ConfigStore(join(dir, "host-config.json")), defaultHostConfig),
    );
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().guestPowerState).toBe("running");
  });

  it("scans the catalog after the guest is running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const app = buildApp(
      new AppState(new ConfigStore(join(dir, "host-config.json")), defaultHostConfig),
    );
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/catalog/scan",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
  });

  it("returns a dashboard snapshot over HTTP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const app = buildApp(
      new AppState(new ConfigStore(join(dir, "host-config.json")), defaultHostConfig),
    );
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });

    await app.inject({
      method: "POST",
      url: "/api/catalog/scan",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/snapshot",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: {
        guestPowerState: "running",
      },
    });
    expect(response.json().games).toHaveLength(2);
    expect(Array.isArray(response.json().sessions)).toBe(true);
    expect(Array.isArray(response.json().events)).toBe(true);
  });

  it("persists provider config changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const configPath = join(dir, "host-config.json");
    const app = buildApp(new AppState(new ConfigStore(configPath), defaultHostConfig));
    apps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        runtimeProvider: "managed-vm",
        managedVm: {
          vmName: " windows-vfio ",
          guestAgentBaseUrl: " http://192.168.1.20:8765 ",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().runtimeProvider).toBe("managed-vm");

    const raw = await readFile(configPath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      runtimeProvider: "managed-vm",
      managedVm: {
        vmName: "windows-vfio",
        guestAgentBaseUrl: "http://192.168.1.20:8765",
      },
    });

    const ignoredResponse = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        runtimeProvider: "unknown-provider",
        managedVm: {
          vmName: " ",
          guestAgentBaseUrl: " ",
        },
      },
    });

    expect(ignoredResponse.statusCode).toBe(200);
    expect(ignoredResponse.json()).toMatchObject({
      runtimeProvider: "managed-vm",
      managedVm: {
        vmName: "windows-vfio",
        guestAgentBaseUrl: "http://192.168.1.20:8765",
      },
    });
  });

  it("normalizes existing host config files when the app starts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const configPath = join(dir, "host-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        runtimeProvider: "bad-provider",
        managedVm: {
          vmName: " ",
          guestAgentBaseUrl: " http://192.168.1.50:8765 ",
          streamMode: "unsupported-stream-mode",
        },
        pinnedGameIds: [" steam:app-400 ", "", "steam:app-400", 42],
      }),
      "utf8",
    );
    const app = buildApp(new AppState(new ConfigStore(configPath), defaultHostConfig));
    apps.push(app);

    const response = await app.inject({
      method: "GET",
      url: "/api/config",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runtimeProvider: "fake",
      managedVm: {
        vmName: "win11-gaming",
        guestAgentBaseUrl: "http://192.168.1.50:8765",
        streamMode: "sunshine-moonlight",
      },
      pinnedGameIds: ["steam:app-400"],
    });
  });

  it("persists pinned game ids in host config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const configPath = join(dir, "host-config.json");
    const app = buildApp(new AppState(new ConfigStore(configPath), defaultHostConfig));
    apps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        pinnedGameIds: [
          " steam:app-400 ",
          "steam:app-400",
          "",
          "ubisoft-connect:anno-1800",
          42,
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().pinnedGameIds).toEqual([
      "steam:app-400",
      "ubisoft-connect:anno-1800",
    ]);

    const raw = await readFile(configPath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      pinnedGameIds: ["steam:app-400", "ubisoft-connect:anno-1800"],
    });
  });

  it("exercises managed-vm endpoints against the guest-agent contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const configPath = join(dir, "host-config.json");

    const managedConfig: HostConfig = {
      runtimeProvider: "managed-vm",
      managedVm: {
        vmName: "windows-vfio",
        guestAgentBaseUrl: "http://127.0.0.1:8765",
        streamMode: "sunshine-moonlight",
      },
      pinnedGameIds: [],
      metadataProviders: {
        theGamesDbApiKey: "",
      },
    };

    const stream = createEventStream();
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

    const runtimeFactory = (config: HostConfig) =>
      new ManagedVmController(config, {
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

          if (url.pathname === "/stream-probe") {
            return jsonResponse({
              ok: true,
              mode: "sunshine-process-and-port",
              detail: "Sunshine process sunshine is running with listener port(s) 47984.",
              checkedAt: "2026-06-08T12:03:00.000Z",
              processName: "sunshine",
              listeningPorts: [47984],
            });
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

    await mkdir(dir, { recursive: true });
    await writeFile(configPath, `${JSON.stringify(managedConfig, null, 2)}\n`, "utf8");

    const app = buildApp(
      new AppState(new ConfigStore(configPath), defaultHostConfig, runtimeFactory),
    );
    apps.push(app);

    const startResponse = await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });
    expect(startResponse.statusCode).toBe(200);
    expect(startResponse.json().guestPowerState).toBe("running");

    const scanResponse = await app.inject({
      method: "POST",
      url: "/api/catalog/scan",
    });
    expect(scanResponse.statusCode).toBe(200);
    expect(scanResponse.json()).toHaveLength(1);

    const launchResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        gameId: "steam:app-400",
      },
    });
    expect(launchResponse.statusCode).toBe(200);
    expect(launchResponse.json().session.id).toBe("session-1");

    const attachDisplayResponse = await app.inject({
      method: "POST",
      url: "/api/runtime/attach-display",
    });
    expect(attachDisplayResponse.statusCode).toBe(200);
    expect(attachDisplayResponse.json()).toMatchObject({
      ok: true,
      detail: "Remote play path is ready. Attach Moonlight or another client to begin play.",
    });

    const detachDisplayResponse = await app.inject({
      method: "POST",
      url: "/api/runtime/detach-display",
    });
    expect(detachDisplayResponse.statusCode).toBe(200);
    expect(detachDisplayResponse.json()).toMatchObject({
      ok: true,
      detail: "Remote client detached. The stream path stays ready for another attachment.",
    });

    const terminateResponse = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/terminate",
    });
    expect(terminateResponse.statusCode).toBe(200);
    expect(terminateResponse.json().runtimeState).toBe("terminated");

    const sessionsResponse = await app.inject({
      method: "GET",
      url: "/api/sessions",
    });
    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.json()).toHaveLength(1);
    expect(sessionsResponse.json()[0].runtimeState).toBe("terminated");

    const diagnosticsResponse = await app.inject({
      method: "GET",
      url: "/api/diagnostics",
    });
    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json()).toMatchObject({
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

    const simulationResponse = await app.inject({
      method: "GET",
      url: "/api/simulation",
    });
    expect(simulationResponse.statusCode).toBe(200);
    expect(simulationResponse.json()).toMatchObject({
      games: [
        {
          gameId: "steam:app-400",
          outcome: "success",
        },
      ],
    });

    const simulationUpdateResponse = await app.inject({
      method: "PUT",
      url: "/api/simulation",
      payload: {
        gameId: "steam:app-400",
        outcome: "fail-before-stream-ready",
        failureMessage: "Portal failed before remote play became ready.",
        launchAcceptedDelayMs: 250.6,
        gameDetectedDelayMs: -5,
        streamReadyDelayMs: "900.4",
        streamProbeProcessNames: [" sunshine ", "Sunshine", "", "sunshine-service"],
        streamProbePorts: [47984, "47984", 48010, 0, 70000],
      },
    });
    expect(simulationUpdateResponse.statusCode).toBe(200);
    expect(simulationUpdateResponse.json()).toMatchObject({
      games: [
        {
          gameId: "steam:app-400",
          outcome: "fail-before-stream-ready",
          failureMessage: "Portal failed before remote play became ready.",
          launchAcceptedDelayMs: 251,
          gameDetectedDelayMs: 350,
          streamReadyDelayMs: 900,
          streamProbeProcessNames: ["sunshine", "sunshine-service"],
          streamProbePorts: [47984, 48010],
        },
      ],
    });

    const simulationResetResponse = await app.inject({
      method: "PUT",
      url: "/api/simulation",
      payload: {
        gameId: "steam:app-400",
        streamProbeProcessNames: ["", " "],
        streamProbePorts: [0, 70000],
      },
    });
    expect(simulationResetResponse.statusCode).toBe(200);

    const streamProbeResponse = await app.inject({
      method: "POST",
      url: "/api/runtime/probe-stream-host",
      payload: {
        processNames: [" sunshine ", "Sunshine", "", "sunshine-service"],
        ports: [47984, "47984", 48010, 0, 70000],
        timeoutMs: 1200.4,
      },
    });
    expect(streamProbeResponse.statusCode).toBe(200);
    expect(streamProbeResponse.json()).toMatchObject({
      ok: true,
      mode: "sunshine-process-and-port",
      processName: "sunshine",
      listeningPorts: [47984],
    });

    expect(calls).toEqual([
      { path: "/health", method: "GET", body: null },
      { path: "/events", method: "GET", body: null },
      { path: "/scan", method: "POST", body: null },
      { path: "/launch", method: "POST", body: JSON.stringify({ gameId: "steam:app-400" }) },
      { path: "/terminate", method: "POST", body: JSON.stringify({ sessionId: "session-1" }) },
      { path: "/simulation", method: "GET", body: null },
      {
        path: "/simulation",
        method: "PUT",
        body: JSON.stringify({
          gameId: "steam:app-400",
          outcome: "fail-before-stream-ready",
          failureMessage: "Portal failed before remote play became ready.",
          launchAcceptedDelayMs: 251,
          streamReadyDelayMs: 900,
          streamProbeProcessNames: ["sunshine", "sunshine-service"],
          streamProbePorts: [47984, 48010],
        }),
      },
      {
        path: "/simulation",
        method: "PUT",
        body: JSON.stringify({
          gameId: "steam:app-400",
          streamProbeProcessNames: [],
          streamProbePorts: [],
        }),
      },
      {
        path: "/stream-probe",
        method: "POST",
        body: JSON.stringify({
          processNames: ["sunshine", "sunshine-service"],
          ports: [47984, 48010],
          timeoutMs: 1200,
        }),
      },
    ]);

    stream.close();
  });

  it("recovers the managed-vm event stream through the host API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const configPath = join(dir, "host-config.json");

    const managedConfig: HostConfig = {
      runtimeProvider: "managed-vm",
      managedVm: {
        vmName: "windows-vfio",
        guestAgentBaseUrl: "http://127.0.0.1:8765",
        streamMode: "sunshine-moonlight",
      },
      pinnedGameIds: [],
      metadataProviders: {
        theGamesDbApiKey: "",
      },
    };

    let streamAvailable = false;
    const stream = createEventStream();
    const runtimeFactory = (config: HostConfig) =>
      new ManagedVmController(config, {
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

    await writeFile(configPath, `${JSON.stringify(managedConfig, null, 2)}\n`, "utf8");

    const app = buildApp(
      new AppState(new ConfigStore(configPath), defaultHostConfig, runtimeFactory),
    );
    apps.push(app);

    const startResponse = await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });
    expect(startResponse.statusCode).toBe(200);

    const diagnosticsBefore = await app.inject({
      method: "GET",
      url: "/api/diagnostics",
    });
    expect(diagnosticsBefore.json()).toMatchObject({
      guestAgentReachable: true,
      eventStreamConnected: false,
      eventStreamState: "reconnecting",
      eventStreamReconnectAttempts: 1,
    });

    streamAvailable = true;
    const recoverResponse = await app.inject({
      method: "POST",
      url: "/api/runtime/recover",
    });
    expect(recoverResponse.statusCode).toBe(200);

    const diagnosticsAfter = await app.inject({
      method: "GET",
      url: "/api/diagnostics",
    });
    expect(diagnosticsAfter.json()).toMatchObject({
      guestAgentReachable: true,
      eventStreamConnected: true,
      eventStreamState: "connected",
      eventStreamReconnectAttempts: 0,
      connectedGuestName: "Windows Gaming VM",
    });

    stream.close();
  });

  it("automatically restores the managed-vm event stream through the host API after a disconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const configPath = join(dir, "host-config.json");
    const firstStream = createEventStream();
    const secondStream = createEventStream();

    const managedConfig: HostConfig = {
      runtimeProvider: "managed-vm",
      managedVm: {
        vmName: "windows-vfio",
        guestAgentBaseUrl: "http://127.0.0.1:8765",
        streamMode: "sunshine-moonlight",
      },
      pinnedGameIds: [],
      metadataProviders: {
        theGamesDbApiKey: "",
      },
    };

    let eventStreamRequestCount = 0;
    const runtimeFactory = (config: HostConfig) =>
      new ManagedVmController(config, {
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
      });

    await writeFile(configPath, `${JSON.stringify(managedConfig, null, 2)}\n`, "utf8");

    const app = buildApp(
      new AppState(new ConfigStore(configPath), defaultHostConfig, runtimeFactory),
    );
    apps.push(app);

    const startResponse = await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });
    expect(startResponse.statusCode).toBe(200);

    firstStream.close();
    await sleep(60);

    const diagnosticsResponse = await app.inject({
      method: "GET",
      url: "/api/diagnostics",
    });
    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json()).toMatchObject({
      guestAgentReachable: true,
      eventStreamConnected: true,
      eventStreamState: "connected",
      eventStreamReconnectAttempts: 0,
      connectedGuestName: "Windows Gaming VM",
    });
    expect(eventStreamRequestCount).toBeGreaterThanOrEqual(2);

    firstStream.close();
    secondStream.close();
  });

  it("surfaces stalled managed-vm stream readiness through the host API diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const configPath = join(dir, "host-config.json");
    const stream = createEventStream();

    const managedConfig: HostConfig = {
      runtimeProvider: "managed-vm",
      managedVm: {
        vmName: "windows-vfio",
        guestAgentBaseUrl: "http://127.0.0.1:8765",
        streamMode: "sunshine-moonlight",
      },
      pinnedGameIds: [],
      metadataProviders: {
        theGamesDbApiKey: "",
      },
    };

    const runtimeFactory = (config: HostConfig) =>
      new ManagedVmController(config, {
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

    await writeFile(configPath, `${JSON.stringify(managedConfig, null, 2)}\n`, "utf8");

    const app = buildApp(
      new AppState(new ConfigStore(configPath), defaultHostConfig, runtimeFactory),
    );
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });

    await app.inject({
      method: "POST",
      url: "/api/catalog/scan",
    });

    await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        gameId: "steam:app-400",
      },
    });

    const diagnosticsResponse = await app.inject({
      method: "GET",
      url: "/api/diagnostics",
    });
    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json()).toMatchObject({
      remotePlayReady: false,
      remotePlayStalled: true,
      activeSessionRunning: true,
      activeSessionStreamReady: false,
      activeSessionExpectedReadyMs: 1100,
    });
    expect(diagnosticsResponse.json().activeSessionAgeMs).toBeGreaterThanOrEqual(6000);
    expect(diagnosticsResponse.json().remotePlayStallDetail).toContain(
      "expected readiness was around 1.1s",
    );

    stream.close();
  });

  it("restarts a stalled managed-vm launch through the host API recovery flow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const configPath = join(dir, "host-config.json");
    const stream = createEventStream();

    const managedConfig: HostConfig = {
      runtimeProvider: "managed-vm",
      managedVm: {
        vmName: "windows-vfio",
        guestAgentBaseUrl: "http://127.0.0.1:8765",
        streamMode: "sunshine-moonlight",
      },
      pinnedGameIds: [],
      metadataProviders: {
        theGamesDbApiKey: "",
      },
    };

    const calls: Array<{ path: string; method: string; body: string | null }> = [];
    let launchRequestCount = 0;
    const runtimeFactory = (config: HostConfig) =>
      new ManagedVmController(config, {
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
            launchRequestCount += 1;

            if (launchRequestCount === 1) {
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

            return jsonResponse({
              session: {
                id: "session-recovered",
                gameId: "steam:app-400",
                runtimeState: "launching",
                guestState: "online",
                streamState: "preparing",
                startedAt: new Date().toISOString(),
              },
            } satisfies GuestAgentLaunchResponse);
          }

          if (url.pathname === "/terminate") {
            return jsonResponse({
              id: "session-stalled",
              gameId: "steam:app-400",
              runtimeState: "terminated",
              guestState: "ready",
              streamState: "unavailable",
              startedAt: new Date(Date.now() - 6000).toISOString(),
              endedAt: new Date().toISOString(),
            } satisfies GameSession);
          }

          return jsonResponse({ message: "Not found" }, 404);
        },
      });

    await writeFile(configPath, `${JSON.stringify(managedConfig, null, 2)}\n`, "utf8");

    const app = buildApp(
      new AppState(new ConfigStore(configPath), defaultHostConfig, runtimeFactory),
    );
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });

    await app.inject({
      method: "POST",
      url: "/api/catalog/scan",
    });

    await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        gameId: "steam:app-400",
      },
    });

    const recoverResponse = await app.inject({
      method: "POST",
      url: "/api/runtime/recover-session",
    });
    expect(recoverResponse.statusCode).toBe(200);
    expect(recoverResponse.json()).toMatchObject({
      session: {
        id: "session-recovered",
        gameId: "steam:app-400",
      },
    });

    const diagnosticsResponse = await app.inject({
      method: "GET",
      url: "/api/diagnostics",
    });
    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json()).toMatchObject({
      remotePlayReady: false,
      remotePlayStalled: false,
      activeSessionRunning: true,
      activeSessionId: "session-recovered",
    });

    expect(calls).toEqual([
      { path: "/health", method: "GET", body: null },
      { path: "/events", method: "GET", body: null },
      { path: "/scan", method: "POST", body: null },
      { path: "/launch", method: "POST", body: JSON.stringify({ gameId: "steam:app-400" }) },
      { path: "/terminate", method: "POST", body: JSON.stringify({ sessionId: "session-stalled" }) },
      { path: "/health", method: "GET", body: null },
      { path: "/launch", method: "POST", body: JSON.stringify({ gameId: "steam:app-400" }) },
    ]);

    stream.close();
  });

  it("surfaces a guest-side failed launch through the host API session model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const configPath = join(dir, "host-config.json");
    const stream = createEventStream();

    const managedConfig: HostConfig = {
      runtimeProvider: "managed-vm",
      managedVm: {
        vmName: "windows-vfio",
        guestAgentBaseUrl: "http://127.0.0.1:8765",
        streamMode: "sunshine-moonlight",
      },
      pinnedGameIds: [],
      metadataProviders: {
        theGamesDbApiKey: "",
      },
    };

    const runtimeFactory = (config: HostConfig) =>
      new ManagedVmController(config, {
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
              session: {
                id: "session-failed",
                gameId: "ubisoft-connect:anno-1800",
                runtimeState: "queued",
                guestState: "online",
                streamState: "preparing",
                startedAt: "2026-06-07T09:10:00.000Z",
              },
            } satisfies GuestAgentLaunchResponse);
          }

          return jsonResponse({ message: "Not found" }, 404);
        },
      });

    await writeFile(configPath, `${JSON.stringify(managedConfig, null, 2)}\n`, "utf8");

    const app = buildApp(
      new AppState(new ConfigStore(configPath), defaultHostConfig, runtimeFactory),
    );
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });

    const launchResponse = await app.inject({
      method: "POST",
      url: "/api/sessions",
      payload: {
        gameId: "ubisoft-connect:anno-1800",
      },
    });
    expect(launchResponse.statusCode).toBe(200);

    const sessionsResponse = await app.inject({
      method: "GET",
      url: "/api/sessions",
    });
    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.json()[0]).toMatchObject({
      id: "session-failed",
      runtimeState: "failed",
      guestState: "error",
      streamState: "unavailable",
      lastError:
        "Sunshine stream handshake timed out before the game session became remotely playable.",
    });

    const diagnosticsResponse = await app.inject({
      method: "GET",
      url: "/api/diagnostics",
    });
    expect(diagnosticsResponse.statusCode).toBe(200);
    expect(diagnosticsResponse.json()).toMatchObject({
      lastSessionError:
        "Sunshine stream handshake timed out before the game session became remotely playable.",
      remotePlayReady: false,
    });

    stream.close();
  });
});
