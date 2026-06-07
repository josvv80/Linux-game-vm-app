import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canLaunchGame, findGameById, sortSessionsByRecency } from "@game-vm-hub/catalog-core";
import type {
  DashboardSnapshot,
  GameRecord,
  GameSession,
  GuestConnection,
  GuestStatusSnapshot,
  LaunchResult,
  RuntimeDiagnostics,
  RuntimeProvider,
  SessionEvent,
} from "@game-vm-hub/shared-types";

export interface FakeEnvironmentOptions {
  stepDelayMs?: number;
}

const defaultGames: GameRecord[] = [
  {
    id: "steam:app-578080",
    title: "PUBG: BATTLEGROUNDS",
    launcher: "steam",
    installState: "installed",
    launchCommandRef: "steam://run/578080",
    lastSeenAt: "2026-06-06T00:00:00.000Z",
    compatibilityFlags: ["prototype", "anti-cheat-unknown", "single-gpu-vfio-risk"],
    guestMetadata: {
      installRoot: "C:\\Program Files (x86)\\Steam",
      launcherAppId: "578080",
    },
  },
  {
    id: "ubisoft-connect:anno-1800",
    title: "Anno 1800",
    launcher: "ubisoft-connect",
    installState: "installed",
    launchCommandRef: "uplay://launch/12345/0",
    lastSeenAt: "2026-06-06T00:00:00.000Z",
    compatibilityFlags: ["prototype", "single-gpu-vfio-risk"],
    guestMetadata: {
      installRoot: "D:\\Games\\Ubisoft",
      launcherAppId: "12345",
    },
  },
];

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

type EventListener = (event: SessionEvent, snapshot: DashboardSnapshot) => void;

export class FakeEnvironment {
  private readonly emitter = new EventEmitter();
  private readonly stepDelayMs: number;
  private games: GameRecord[] = [];
  private sessions: GameSession[] = [];
  private events: SessionEvent[] = [];
  private status: GuestStatusSnapshot = {
    guestPowerState: "offline",
    agentState: "offline",
    streamHostState: "unavailable",
    scanState: "idle",
    warnings: [
      "Prototype runtime uses a fake Windows guest.",
      "Single-GPU VFIO path is not implemented in this slice.",
    ],
  };

  readonly runtimeProvider: RuntimeProvider;
  readonly guestConnection: GuestConnection;

  constructor(options: FakeEnvironmentOptions = {}) {
    this.stepDelayMs = options.stepDelayMs ?? 200;

    this.runtimeProvider = {
      getStatus: async () => this.getStatus(),
      prepare: async () => this.prepare(),
      startGuest: async () => this.startGuest(),
      stopGuest: async (force) => this.stopGuest(force),
      attachDisplay: async () => this.attachDisplay(),
      getDiagnostics: async () => this.getDiagnostics(),
    };

    this.guestConnection = {
      getHealth: async () => this.getStatus(),
      scanGames: async () => this.scanGames(),
      listGames: async () => this.listGames(),
      launchGame: async (gameId) => this.launchGame(gameId),
      terminateSession: async (sessionId) => this.terminateSession(sessionId),
    };
  }

  subscribe(listener: EventListener): () => void {
    this.emitter.on("event", listener);

    return () => {
      this.emitter.off("event", listener);
    };
  }

  snapshot(): DashboardSnapshot {
    return {
      status: clone(this.status),
      games: clone(this.games),
      sessions: sortSessionsByRecency(clone(this.sessions)),
      events: clone(this.events),
    };
  }

  async getStatus(): Promise<GuestStatusSnapshot> {
    return clone(this.status);
  }

  async prepare(): Promise<GuestStatusSnapshot> {
    if (this.status.guestPowerState === "offline") {
      this.status.guestPowerState = "starting";
      this.status.agentState = "booting";
      this.status.streamHostState = "preparing";
    }

    return this.getStatus();
  }

  async startGuest(): Promise<GuestStatusSnapshot> {
    if (this.status.guestPowerState === "running") {
      return this.getStatus();
    }

    await this.prepare();
    await delay(this.stepDelayMs);

    this.status.guestPowerState = "running";
    this.status.agentState = "online";
    this.status.connectedGuestName = "Fake Windows Guest";
    this.pushEvent({
      type: "guest.connected",
      level: "info",
      message: "Windows guest connected to the host control plane.",
    });

    await delay(this.stepDelayMs);
    this.status.agentState = "ready";
    this.status.streamHostState = "ready";

    return this.getStatus();
  }

  async stopGuest(force = false): Promise<GuestStatusSnapshot> {
    if (this.status.guestPowerState === "offline") {
      return this.getStatus();
    }

    this.status.guestPowerState = "stopping";

    const activeSession = this.sessions.find(
      (session) =>
        session.id === this.status.activeSessionId &&
        (session.runtimeState === "launching" || session.runtimeState === "running"),
    );

    if (activeSession) {
      activeSession.runtimeState = force ? "terminated" : "ended";
      activeSession.endedAt = now();
      this.pushEvent({
        type: "session.ended",
        level: "info",
        message: force
          ? "Active session was terminated during guest shutdown."
          : "Active session ended during guest shutdown.",
        gameId: activeSession.gameId,
        sessionId: activeSession.id,
      });
    }

    await delay(this.stepDelayMs);
    const nextStatus: GuestStatusSnapshot = {
      guestPowerState: "offline",
      agentState: "offline",
      streamHostState: "unavailable",
      scanState: "idle",
      warnings: [...this.status.warnings],
    };

    if (this.status.lastEventAt) {
      nextStatus.lastEventAt = this.status.lastEventAt;
    }

    this.status = nextStatus;

    this.pushEvent({
      type: "guest.disconnected",
      level: "info",
      message: "Windows guest disconnected from the host control plane.",
    });

    return this.getStatus();
  }

  async attachDisplay(): Promise<{ ok: boolean; detail: string }> {
    if (this.status.streamHostState !== "ready") {
      return {
        ok: false,
        detail: "Sunshine/Moonlight path is not ready yet.",
      };
    }

    return {
      ok: true,
      detail: "Moonlight would attach here in the real runtime provider.",
    };
  }

  async getDiagnostics(): Promise<RuntimeDiagnostics> {
    const diagnostics: RuntimeDiagnostics = {
      warnings: [...this.status.warnings],
      sessionCount: this.sessions.length,
      guestAgentReachable: this.status.guestPowerState === "running",
      eventStreamConnected: this.status.guestPowerState === "running",
      remotePlayReady: this.status.streamHostState === "ready",
    };

    if (this.status.connectedGuestName) {
      diagnostics.connectedGuestName = this.status.connectedGuestName;
    }

    return diagnostics;
  }

  async scanGames(): Promise<GameRecord[]> {
    if (this.status.guestPowerState !== "running") {
      throw new Error("Cannot scan catalog while the guest is offline.");
    }

    this.status.scanState = "running";
    this.status.agentState = "scanning";
    this.pushEvent({
      type: "guest.scan.started",
      level: "info",
      message: "Windows guest started scanning installed launchers.",
    });

    await delay(this.stepDelayMs);
    this.games = defaultGames.map((game) => ({
      ...game,
      lastSeenAt: now(),
      compatibilityFlags: [...game.compatibilityFlags],
      guestMetadata: { ...game.guestMetadata },
    }));

    this.status.scanState = "complete";
    this.status.agentState = "ready";
    this.pushEvent({
      type: "guest.scan.completed",
      level: "info",
      message: `Catalog scan completed with ${this.games.length} games.`,
    });

    return this.listGames();
  }

  async listGames(): Promise<GameRecord[]> {
    return clone(this.games);
  }

  async launchGame(gameId: string): Promise<LaunchResult> {
    const game = findGameById(this.games, gameId);

    if (!game) {
      throw new Error(`Unknown game id: ${gameId}`);
    }

    const launchCheck = canLaunchGame(game, this.status);

    if (!launchCheck.canLaunch) {
      throw new Error(launchCheck.reason);
    }

    const session: GameSession = {
      id: randomUUID(),
      gameId,
      runtimeState: "queued",
      guestState: this.status.agentState,
      streamState: "preparing",
      startedAt: now(),
    };

    this.sessions = [session, ...this.sessions];
    this.status.activeSessionId = session.id;
    this.status.streamHostState = "preparing";
    this.pushEvent({
      type: "session.launch.requested",
      level: "info",
      message: `Launch requested for ${game.title}.`,
      gameId,
      sessionId: session.id,
    });

    await delay(this.stepDelayMs);
    session.runtimeState = "launching";
    session.guestState = "online";
    this.pushEvent({
      type: "session.launch.started",
      level: "info",
      message: `Launcher accepted the launch request for ${game.title}.`,
      gameId,
      sessionId: session.id,
    });

    await delay(this.stepDelayMs);
    session.runtimeState = "running";
    session.guestState = "ready";
    this.pushEvent({
      type: "session.game.detected",
      level: "info",
      message: `${game.title} process was detected in the Windows guest.`,
      gameId,
      sessionId: session.id,
    });

    await delay(this.stepDelayMs);
    session.streamState = "ready";
    this.status.streamHostState = "ready";
    this.pushEvent({
      type: "session.streaming.ready",
      level: "info",
      message: "Sunshine/Moonlight path is ready for streaming.",
      gameId,
      sessionId: session.id,
    });

    return { session: clone(session) };
  }

  async terminateSession(sessionId: string): Promise<GameSession | null> {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);

    if (!session || session.runtimeState === "ended" || session.runtimeState === "terminated") {
      return session ? clone(session) : null;
    }

    session.runtimeState = "terminated";
    session.streamState = "unavailable";
    session.endedAt = now();
    delete this.status.activeSessionId;
    this.status.streamHostState = "ready";

    this.pushEvent({
      type: "session.ended",
      level: "info",
      message: "The active session was terminated from the host control plane.",
      gameId: session.gameId,
      sessionId: session.id,
    });

    return clone(session);
  }

  private pushEvent(
    partial: Omit<SessionEvent, "id" | "createdAt">,
  ): SessionEvent {
    const event: SessionEvent = {
      id: randomUUID(),
      createdAt: now(),
      ...partial,
    };

    this.events = [event, ...this.events].slice(0, 40);
    this.status.lastEventAt = event.createdAt;
    this.emitter.emit("event", clone(event), this.snapshot());
    return event;
  }
}

export function createFakeEnvironment(
  options?: FakeEnvironmentOptions,
): FakeEnvironment {
  return new FakeEnvironment(options);
}
