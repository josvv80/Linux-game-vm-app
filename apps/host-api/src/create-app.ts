import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { DashboardMessage } from "@game-vm-hub/shared-types";
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

  app.post("/api/runtime/start", async () => state.startRuntime());
  app.post("/api/runtime/stop", async (request) =>
    state.stopRuntime(Boolean((request.body as StopRuntimeBody | undefined)?.force)),
  );
  app.put("/api/config", async (request) =>
    state.updateConfig(request.body as UpdateConfigBody),
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
