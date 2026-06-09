import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type {
  DashboardMessage,
  SimulationUpdateRequest,
  StreamProbeRequest,
} from "@game-vm-hub/shared-types";
import { AppState, createAppState } from "./state.js";

interface LaunchSessionBody {
  gameId: string;
}

interface StopRuntimeBody {
  force?: boolean;
}

interface UpdateConfigBody {
  runtimeProvider?: "fake" | "managed-vm";
  managedVm?: {
    vmName?: string;
    guestAgentBaseUrl?: string;
  };
  pinnedGameIds?: string[];
}

interface UpdateSimulationBody {
  gameId: string;
  outcome?: "success" | "fail-before-stream-ready";
  failureMessage?: string;
  launchAcceptedDelayMs?: number;
  gameDetectedDelayMs?: number;
  streamReadyDelayMs?: number;
  streamProbeProcessNames?: string[];
  streamProbePorts?: number[];
}

interface ProbeStreamBody {
  processNames?: string[];
  ports?: number[];
  timeoutMs?: number;
}

function normalizeProcessNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<string>();
  const processNames: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const processName = item.trim();
    const key = processName.toLowerCase();

    if (processName.length > 0 && !seen.has(key)) {
      processNames.push(processName);
      seen.add(key);
    }
  }

  return processNames.length > 0 ? processNames : undefined;
}

function normalizePorts(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<number>();
  const ports: number[] = [];

  for (const item of value) {
    const port = typeof item === "number" ? item : Number(item);

    if (Number.isInteger(port) && port > 0 && port <= 65535 && !seen.has(port)) {
      ports.push(port);
      seen.add(port);
    }
  }

  return ports.length > 0 ? ports : undefined;
}

function normalizeTimeoutMs(value: unknown): number | undefined {
  const timeoutMs = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    return undefined;
  }

  return Math.round(timeoutMs);
}

function normalizeProbeStreamBody(body: ProbeStreamBody | undefined): StreamProbeRequest {
  const request: StreamProbeRequest = {};
  const processNames = normalizeProcessNames(body?.processNames);
  const ports = normalizePorts(body?.ports);
  const timeoutMs = normalizeTimeoutMs(body?.timeoutMs);

  if (processNames !== undefined) {
    request.processNames = processNames;
  }
  if (ports !== undefined) {
    request.ports = ports;
  }
  if (timeoutMs !== undefined) {
    request.timeoutMs = timeoutMs;
  }

  return request;
}

function normalizeSimulationBody(
  body: UpdateSimulationBody | undefined,
): SimulationUpdateRequest {
  const request: SimulationUpdateRequest = {
    gameId: body?.gameId ?? "",
  };
  const processNames = normalizeProcessNames(body?.streamProbeProcessNames);
  const ports = normalizePorts(body?.streamProbePorts);
  const launchAcceptedDelayMs = normalizeTimeoutMs(body?.launchAcceptedDelayMs);
  const gameDetectedDelayMs = normalizeTimeoutMs(body?.gameDetectedDelayMs);
  const streamReadyDelayMs = normalizeTimeoutMs(body?.streamReadyDelayMs);

  if (body?.outcome !== undefined) {
    request.outcome = body.outcome;
  }
  if (body?.failureMessage !== undefined) {
    request.failureMessage = body.failureMessage;
  }
  if (launchAcceptedDelayMs !== undefined) {
    request.launchAcceptedDelayMs = launchAcceptedDelayMs;
  }
  if (gameDetectedDelayMs !== undefined) {
    request.gameDetectedDelayMs = gameDetectedDelayMs;
  }
  if (streamReadyDelayMs !== undefined) {
    request.streamReadyDelayMs = streamReadyDelayMs;
  }
  if (processNames !== undefined) {
    request.streamProbeProcessNames = processNames;
  }
  if (ports !== undefined) {
    request.streamProbePorts = ports;
  }

  return request;
}

export function buildApp(state: AppState = createAppState()) {
  const app = Fastify({
    logger: false,
  });

  void app.register(cors, {
    origin: true,
  });
  void app.register(websocket);

  app.get("/health", async () => ({
    ok: true,
    status: await state.status(),
  }));

  app.get("/api/status", async () => state.status());
  app.get("/api/config", async () => state.getConfig());
  app.get("/api/catalog/games", async () => state.listGames());
  app.get("/api/catalog/games/:id", async (request, reply) => {
    const game = await state.getGame((request.params as { id: string }).id);

    if (!game) {
      return reply.code(404).send({ message: "Game not found." });
    }

    return game;
  });
  app.get("/api/sessions", async () => state.snapshot().sessions);
  app.get("/api/diagnostics", async () => state.diagnostics());
  app.get("/api/simulation", async () => state.getSimulationCatalog());

  app.post("/api/runtime/start", async () => state.startRuntime());
  app.post("/api/runtime/recover", async () => state.prepareRuntime());
  app.post("/api/runtime/recover-session", async () => state.recoverSession());
  app.post("/api/runtime/stop", async (request) =>
    state.stopRuntime(Boolean((request.body as StopRuntimeBody | undefined)?.force)),
  );
  app.post("/api/runtime/detach-display", async () => state.detachDisplay());
  app.put("/api/config", async (request) =>
    state.updateConfig(request.body as UpdateConfigBody),
  );
  app.put("/api/simulation", async (request) =>
    state.updateSimulation(
      normalizeSimulationBody(request.body as UpdateSimulationBody | undefined),
    ),
  );
  app.post("/api/runtime/probe-stream-host", async (request) =>
    state.probeStreamHost(normalizeProbeStreamBody(request.body as ProbeStreamBody | undefined)),
  );
  app.post("/api/catalog/scan", async () => state.scanCatalog());
  app.post("/api/runtime/attach-display", async () => state.attachDisplay());
  app.post("/api/sessions", async (request) => {
    const body = request.body as LaunchSessionBody;
    return state.createSession(body.gameId);
  });
  app.post("/api/sessions/:id/terminate", async (request, reply) => {
    const session = await state.terminateSession((request.params as { id: string }).id);

    if (!session) {
      return reply.code(404).send({ message: "Session not found." });
    }

    return session;
  });

  app.get(
    "/api/events",
    { websocket: true },
    (socket) => {
      const initialMessage: DashboardMessage = {
        type: "snapshot",
        payload: state.snapshot(),
      };
      socket.send(JSON.stringify(initialMessage));

      const unsubscribe = state.subscribe((event, snapshot) => {
        const message: DashboardMessage = {
          type: "event",
          event,
          payload: snapshot,
        };
        socket.send(JSON.stringify(message));
      });

      socket.on("close", () => {
        unsubscribe();
      });
    },
  );

  return app;
}
