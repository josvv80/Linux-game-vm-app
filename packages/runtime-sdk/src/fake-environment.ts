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
  SimulationCatalog,
  SimulationGameProfile,
  SimulationUpdateRequest,
  StreamProbeRequest,
  StreamProbeResult,
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

function parseDelay(value?: string): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

type EventListener = (event: SessionEvent, snapshot: DashboardSnapshot) => void;

const defaultStreamProbeProcessNames = ["sunshine", "Sunshine", "sunshine-tray"];
const defaultStreamProbePorts = [47984, 47989, 47990, 48010];

export class FakeEnvironment {
  private readonly emitter = new EventEmitter();
  private readonly stepDelayMs: number;
  private readonly simulationProfiles = new Map<string, SimulationGameProfile>();
  private games: GameRecord[] = [];
  private sessions: GameSession[] = [];
  private events: SessionEvent[] = [];
  private remoteClientAttached = false;
  private lastDisplayAttachDetail: string | null = null;
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
    this.seedSimulationProfiles();

    this.runtimeProvider = {
      getStatus: async () => this.getStatus(),
      prepare: async () => this.prepare(),
      startGuest: async () => this.startGuest(),
      stopGuest: async (force) => this.stopGuest(force),
      attachDisplay: async () => this.attachDisplay(),
      detachDisplay: async () => this.detachDisplay(),
      getDiagnostics: async () => this.getDiagnostics(),
    };

    this.guestConnection = {
      getHealth: async () => this.getStatus(),
      scanGames: async () => this.scanGames(),
      listGames: async () => this.listGames(),
      getSimulationCatalog: async () => this.getSimulationCatalog(),
      updateSimulation: async (request) => this.updateSimulation(request),
      probeStreamHost: async (request) => this.probeStreamHost(request),
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
    this.remoteClientAttached = false;
    this.lastDisplayAttachDetail = "Remote display handoff cleared because the guest stopped.";
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
    const activeSession = this.sessions.find(
      (session) =>
        session.id === this.status.activeSessionId &&
        (session.runtimeState === "launching" || session.runtimeState === "running"),
    );

    if (!activeSession || activeSession.streamState !== "ready") {
      this.remoteClientAttached = false;
      this.lastDisplayAttachDetail =
        "No stream-ready active session is available for remote display attachment.";
      this.pushEvent({
        type: "display.attach.failed",
        level: "error",
        message: this.lastDisplayAttachDetail,
      });

      return {
        ok: false,
        detail: this.lastDisplayAttachDetail,
      };
    }

    this.remoteClientAttached = true;
    this.lastDisplayAttachDetail =
      "Moonlight would attach here in the real runtime provider.";
    this.pushEvent({
      type: "display.attached",
      level: "info",
      message: this.lastDisplayAttachDetail,
    });

    return {
      ok: true,
      detail: this.lastDisplayAttachDetail,
    };
  }

  async detachDisplay(): Promise<{ ok: boolean; detail: string }> {
    if (!this.remoteClientAttached) {
      this.lastDisplayAttachDetail = "No remote client is currently attached.";
      this.pushEvent({
        type: "display.detach.failed",
        level: "error",
        message: this.lastDisplayAttachDetail,
      });

      return {
        ok: false,
        detail: this.lastDisplayAttachDetail,
      };
    }

    this.remoteClientAttached = false;
    this.lastDisplayAttachDetail =
      "Remote client detached. The stream path stays ready for another attachment.";
    this.pushEvent({
      type: "display.detached",
      level: "info",
      message: this.lastDisplayAttachDetail,
    });

    return {
      ok: true,
      detail: this.lastDisplayAttachDetail,
    };
  }

  async getDiagnostics(): Promise<RuntimeDiagnostics> {
    const activeSession = this.sessions.find(
      (session) =>
        session.id === this.status.activeSessionId &&
        (session.runtimeState === "launching" || session.runtimeState === "running"),
    );
    const activeGame = activeSession ? this.games.find((game) => game.id === activeSession.gameId) : undefined;
    const activeSessionAgeMs = activeSession
      ? Math.max(0, Date.now() - Date.parse(activeSession.startedAt))
      : undefined;
    const expectedReadyFromMetadata = activeGame
      ? [
          parseDelay(activeGame.guestMetadata.launchAcceptedDelayMs),
          parseDelay(activeGame.guestMetadata.gameDetectedDelayMs),
          parseDelay(activeGame.guestMetadata.streamReadyDelayMs),
        ].reduce<number>((total, next) => total + (next ?? 0), 0)
      : 0;
    const activeSessionExpectedReadyMs =
      activeSession && expectedReadyFromMetadata > 0 ? expectedReadyFromMetadata : undefined;
    const remotePlayStalled = Boolean(
      activeSession &&
        activeSession.streamState !== "ready" &&
        activeSessionAgeMs !== undefined &&
        activeSessionExpectedReadyMs !== undefined &&
        activeSessionAgeMs > activeSessionExpectedReadyMs + 2000,
    );

    const diagnostics: RuntimeDiagnostics = {
      warnings: [...this.status.warnings],
      sessionCount: this.sessions.length,
      guestAgentReachable: this.status.guestPowerState === "running",
      eventStreamConnected: this.status.guestPowerState === "running",
      eventStreamState:
        this.status.guestPowerState === "running" ? "connected" : "disconnected",
      eventStreamReconnectAttempts: 0,
      remotePlayReady: activeSession?.streamState === "ready",
      remotePlayStalled,
      remoteClientAttached: this.remoteClientAttached,
      activeSessionRunning: Boolean(activeSession),
      activeSessionStreamReady: activeSession?.streamState === "ready",
    };

    if (this.status.connectedGuestName) {
      diagnostics.connectedGuestName = this.status.connectedGuestName;
    }

    if (activeSession) {
      diagnostics.activeSessionId = activeSession.id;
      if (activeSessionAgeMs !== undefined) {
        diagnostics.activeSessionAgeMs = activeSessionAgeMs;
      }
      if (activeSessionExpectedReadyMs !== undefined) {
        diagnostics.activeSessionExpectedReadyMs = activeSessionExpectedReadyMs;
      }
    }

    if (remotePlayStalled) {
      diagnostics.remotePlayStallDetail =
        "The active session has exceeded its expected stream-ready timing window.";
    }

    if (this.lastDisplayAttachDetail) {
      diagnostics.lastDisplayAttachDetail = this.lastDisplayAttachDetail;
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
    this.applySimulationProfiles(this.games);

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

  async getSimulationCatalog(): Promise<SimulationCatalog> {
    return {
      games: this.listSimulationProfiles(),
    };
  }

  async updateSimulation(request: SimulationUpdateRequest): Promise<SimulationCatalog> {
    const profile = this.simulationProfiles.get(request.gameId);

    if (!profile) {
      throw new Error(`Unknown simulation profile: ${request.gameId}`);
    }

    if (request.outcome) {
      profile.outcome = request.outcome;
    }
    if (request.failureMessage !== undefined) {
      profile.failureMessage = request.failureMessage;
    }
    if (request.launchAcceptedDelayMs !== undefined) {
      profile.launchAcceptedDelayMs = request.launchAcceptedDelayMs;
    }
    if (request.gameDetectedDelayMs !== undefined) {
      profile.gameDetectedDelayMs = request.gameDetectedDelayMs;
    }
    if (request.streamReadyDelayMs !== undefined) {
      profile.streamReadyDelayMs = request.streamReadyDelayMs;
    }
    if (request.streamProbeProcessNames !== undefined) {
      profile.streamProbeProcessNames =
        request.streamProbeProcessNames.length > 0
          ? [...request.streamProbeProcessNames]
          : [...defaultStreamProbeProcessNames];
    }
    if (request.streamProbePorts !== undefined) {
      profile.streamProbePorts =
        request.streamProbePorts.length > 0
          ? [...request.streamProbePorts]
          : [...defaultStreamProbePorts];
    }

    this.applySimulationProfiles(this.games);

    return {
      games: this.listSimulationProfiles(),
    };
  }

  async probeStreamHost(request: StreamProbeRequest): Promise<StreamProbeResult> {
    const ports = request.ports && request.ports.length > 0 ? [...request.ports] : [47984, 47989];

    return {
      ok: this.status.guestPowerState === "running",
      mode: "fake-stream-probe",
      detail:
        this.status.guestPowerState === "running"
          ? `Fake runtime reports Sunshine-compatible listener port(s) ${ports.join(", ")}.`
          : "Fake runtime cannot probe stream readiness while the guest is offline.",
      checkedAt: now(),
      processName: "sunshine",
      listeningPorts: ports,
    };
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
    this.remoteClientAttached = false;
    this.lastDisplayAttachDetail =
      "Remote client must attach again after a new launch reaches stream readiness.";
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
    this.remoteClientAttached = false;
    this.lastDisplayAttachDetail =
      "Remote display handoff cleared because the active session was terminated.";

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

  private seedSimulationProfiles() {
    for (const game of defaultGames) {
      this.simulationProfiles.set(game.id, {
        gameId: game.id,
        outcome: game.id === "ubisoft-connect:anno-1800" ? "fail-before-stream-ready" : "success",
        failureMessage:
          game.id === "ubisoft-connect:anno-1800"
            ? "Sunshine stream handshake timed out before the game session became remotely playable."
            : `Simulated launch failure for ${game.title}.`,
        launchAcceptedDelayMs: 250,
        gameDetectedDelayMs: 350,
        streamReadyDelayMs: 500,
        streamProbeProcessNames: [...defaultStreamProbeProcessNames],
        streamProbePorts: [...defaultStreamProbePorts],
      });
    }
  }

  private listSimulationProfiles(): SimulationGameProfile[] {
    return [...this.simulationProfiles.values()]
      .sort((left, right) => left.gameId.localeCompare(right.gameId))
      .map((profile) => clone(profile));
  }

  private applySimulationProfiles(games: GameRecord[]) {
    for (const game of games) {
      const profile = this.simulationProfiles.get(game.id);

      if (!profile) {
        continue;
      }

      game.guestMetadata.simulatedOutcome = profile.outcome;
      game.guestMetadata.simulatedFailure = profile.failureMessage;
      game.guestMetadata.launchAcceptedDelayMs = String(profile.launchAcceptedDelayMs);
      game.guestMetadata.gameDetectedDelayMs = String(profile.gameDetectedDelayMs);
      game.guestMetadata.streamReadyDelayMs = String(profile.streamReadyDelayMs);
      game.guestMetadata.streamProbeProcessNames = profile.streamProbeProcessNames?.join(";") ?? "";
      game.guestMetadata.streamProbePorts = profile.streamProbePorts?.join(";") ?? "";
    }
  }
}

export function createFakeEnvironment(
  options?: FakeEnvironmentOptions,
): FakeEnvironment {
  return new FakeEnvironment(options);
}
