import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type {
  DashboardSnapshot,
  GameRecord,
  GameSession,
  GuestAgentEventEnvelope,
  GuestAgentGameListResponse,
  GuestAgentHealthResponse,
  GuestAgentLaunchRequest,
  GuestAgentLaunchResponse,
  GuestAgentTerminateRequest,
  GuestConnection,
  GuestStatusSnapshot,
  HostConfig,
  RuntimeDiagnostics,
  RuntimeProvider,
  SessionEvent,
} from "@game-vm-hub/shared-types";

type EventListener = (event: SessionEvent, snapshot: DashboardSnapshot) => void;

export interface ManagedVmControllerOptions {
  fetchImpl?: typeof fetch;
}

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ManagedVmController {
  private readonly emitter = new EventEmitter();
  private readonly events: SessionEvent[] = [];
  private readonly sessions: GameSession[] = [];
  private readonly games: GameRecord[] = [];
  private readonly fetchImpl: typeof fetch;
  private eventStreamAbortController: AbortController | null = null;
  private eventStreamTask: Promise<void> | null = null;
  private remoteEventsEnabled = false;
  private lastGuestAgentError: string | null = null;
  private lastEventStreamError: string | null = null;
  private lastScanError: string | null = null;
  private guestAgentReachable = false;
  private status: GuestStatusSnapshot;

  readonly runtimeProvider: RuntimeProvider;
  readonly guestConnection: GuestConnection;

  constructor(
    private readonly config: HostConfig,
    options: ManagedVmControllerOptions = {},
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.status = this.createLocalStatus({
      guestPowerState: "offline",
      agentState: "offline",
      streamHostState: "unavailable",
      scanState: "idle",
      warnings: [],
    });

    this.runtimeProvider = {
      getStatus: async () => this.getStatus(),
      prepare: async () => this.prepare(),
      startGuest: async () => this.startGuest(),
      stopGuest: async () => this.stopGuest(),
      attachDisplay: async () => this.attachDisplay(),
      getDiagnostics: async () => this.getDiagnostics(),
    };

    this.guestConnection = {
      getHealth: async () => this.refreshHealth(),
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
      sessions: clone(this.sessions),
      events: clone(this.events),
    };
  }

  async getStatus(): Promise<GuestStatusSnapshot> {
    return clone(this.status);
  }

  async prepare(): Promise<GuestStatusSnapshot> {
    await this.refreshHealth();
    await this.ensureEventStream();
    return this.getStatus();
  }

  async startGuest(): Promise<GuestStatusSnapshot> {
    const wasRunning = this.status.guestPowerState === "running";

    this.status = this.createLocalStatus({
      ...this.status,
      guestPowerState: "starting",
      agentState: "booting",
      streamHostState: "preparing",
    });

    try {
      const health = await this.fetchJson<GuestAgentHealthResponse>("/health");
      this.applyRemoteHealth(health);
      this.guestAgentReachable = true;
      this.lastGuestAgentError = null;

      if (!wasRunning) {
        this.pushEvent(
          "guest.connected",
          `Managed VM guest agent responded from ${this.config.managedVm.guestAgentBaseUrl}.`,
        );
      }

      await this.ensureEventStream();

      return this.getStatus();
    } catch (error) {
      const detail = toErrorMessage(error);
      this.guestAgentReachable = false;
      this.lastGuestAgentError = detail;
      this.status = this.createLocalStatus(
        {
          ...this.status,
          guestPowerState: "offline",
          agentState: "error",
          streamHostState: "unavailable",
          scanState: "error",
        },
        [`Last guest-agent connection error: ${detail}`],
      );
      this.pushEvent(
        "guest.disconnected",
        `Managed VM guest agent probe failed: ${detail}`,
        "error",
      );
      throw new Error(
        `Managed VM guest agent is unreachable at ${this.config.managedVm.guestAgentBaseUrl}: ${detail}`,
      );
    }
  }

  async stopGuest(): Promise<GuestStatusSnapshot> {
    this.stopEventStream();
    this.pushEvent(
      "guest.disconnected",
      "Managed VM stop was requested, but VM power orchestration is not implemented yet.",
    );
    return this.getStatus();
  }

  async attachDisplay(): Promise<{ ok: boolean; detail: string }> {
    if (this.status.streamHostState !== "ready") {
      return {
        ok: false,
        detail: "Guest stream path is not ready yet.",
      };
    }

    return {
      ok: true,
      detail: "The managed VM guest reported a ready stream path.",
    };
  }

  async getDiagnostics(): Promise<RuntimeDiagnostics> {
    const diagnostics: RuntimeDiagnostics = {
      warnings: [...this.status.warnings],
      sessionCount: this.sessions.length,
      guestAgentReachable: this.guestAgentReachable,
      eventStreamConnected: this.remoteEventsEnabled,
      remotePlayReady: this.status.streamHostState === "ready",
    };

    if (this.status.connectedGuestName) {
      diagnostics.connectedGuestName = this.status.connectedGuestName;
    }

    if (this.lastGuestAgentError) {
      diagnostics.lastGuestAgentError = this.lastGuestAgentError;
    }

    if (this.lastEventStreamError) {
      diagnostics.lastEventStreamError = this.lastEventStreamError;
    }

    if (this.lastScanError) {
      diagnostics.lastScanError = this.lastScanError;
    }

    return diagnostics;
  }

  async scanGames(): Promise<GameRecord[]> {
    await this.ensureConnected();

    this.status = this.createLocalStatus({
      ...this.status,
      agentState: "scanning",
      scanState: "running",
    });
    this.pushLocalEvent("guest.scan.started", "Managed VM guest scan started.");

    try {
      const response = await this.fetchJson<GuestAgentGameListResponse>("/scan", {
        method: "POST",
      });

      this.replaceGames(response.games);
      this.lastScanError = null;
      this.status = this.createLocalStatus({
        ...this.status,
        agentState: "ready",
        scanState: "complete",
      });
      this.pushLocalEvent(
        "guest.scan.completed",
        `Managed VM guest scan completed with ${this.games.length} games.`,
      );
      return this.listGames();
    } catch (error) {
      const detail = toErrorMessage(error);
      this.lastScanError = detail;
      this.status = this.createLocalStatus(
        {
          ...this.status,
          agentState: "error",
          scanState: "error",
        },
        [`Last guest scan error: ${detail}`],
      );
      this.pushLocalEvent("guest.scan.failed", `Managed VM guest scan failed: ${detail}`, "error");
      throw new Error(`Managed VM guest scan failed: ${detail}`);
    }
  }

  async listGames(): Promise<GameRecord[]> {
    return clone(this.games);
  }

  async launchGame(gameId: string): Promise<GuestAgentLaunchResponse> {
    await this.ensureConnected();

    const response = await this.fetchJson<GuestAgentLaunchResponse>("/launch", {
      method: "POST",
      body: JSON.stringify({ gameId } satisfies GuestAgentLaunchRequest),
      headers: {
        "content-type": "application/json",
      },
    });

    this.upsertSession(response.session);
    this.status = this.createLocalStatus({
      ...this.status,
      activeSessionId: response.session.id,
      agentState: response.session.guestState,
      streamHostState: response.session.streamState,
    });

    this.pushLocalEvent(
      "session.launch.started",
      `Managed VM guest accepted launch for ${response.session.gameId}.`,
      "info",
      {
        gameId: response.session.gameId,
        sessionId: response.session.id,
      },
    );

    if (response.session.streamState === "ready") {
      this.pushLocalEvent(
        "session.streaming.ready",
        "Managed VM guest reported the stream path as ready.",
        "info",
        {
          gameId: response.session.gameId,
          sessionId: response.session.id,
        },
      );
    }

    return clone(response);
  }

  async terminateSession(sessionId: string): Promise<GameSession | null> {
    await this.ensureConnected();

    const response = await this.fetch(
      "/terminate",
      {
        method: "POST",
        body: JSON.stringify({ sessionId } satisfies GuestAgentTerminateRequest),
        headers: {
          "content-type": "application/json",
        },
      },
      true,
    );

    if (response.status === 404) {
      return null;
    }

    const session = (await response.json()) as GameSession;
    this.upsertSession(session);

    if (this.status.activeSessionId === session.id) {
      const nextStatus = {
        ...this.status,
        streamHostState: "ready" as const,
      };
      delete nextStatus.activeSessionId;
      this.status = this.createLocalStatus(nextStatus);
    }

    this.pushLocalEvent(
      "session.ended",
      "Managed VM guest session terminated.",
      "info",
      {
        gameId: session.gameId,
        sessionId: session.id,
      },
    );

    return clone(session);
  }

  private async refreshHealth(): Promise<GuestStatusSnapshot> {
    const response = await this.fetchJson<GuestAgentHealthResponse>("/health");
    this.applyRemoteHealth(response);
    return this.getStatus();
  }

  private async ensureConnected() {
    if (this.status.guestPowerState === "running" && this.status.agentState !== "error") {
      if (!this.remoteEventsEnabled) {
        await this.ensureEventStream();
      }
      return;
    }

    await this.startGuest();
  }

  private async ensureEventStream() {
    if (this.eventStreamTask) {
      return;
    }

    const abortController = new AbortController();
    this.eventStreamAbortController = abortController;

    try {
      const response = await this.fetch("/events", {
        headers: {
          accept: "text/event-stream",
        },
        signal: abortController.signal,
      });

      if (!response.body) {
        throw new Error("Guest event stream returned no response body.");
      }

      this.remoteEventsEnabled = true;
      this.lastEventStreamError = null;
      this.eventStreamTask = this.consumeEventStream(response.body, abortController.signal)
        .catch((error) => {
          if (!abortController.signal.aborted) {
            this.lastEventStreamError = toErrorMessage(error);
            this.status = this.createLocalStatus(this.status, [
              `Guest event stream disconnected: ${this.lastEventStreamError}`,
            ]);
          }
        })
        .finally(() => {
          if (this.eventStreamAbortController === abortController) {
            this.eventStreamAbortController = null;
          }
          this.eventStreamTask = null;
          this.remoteEventsEnabled = false;
        });
    } catch (error) {
      this.eventStreamAbortController = null;
      this.eventStreamTask = null;
      this.remoteEventsEnabled = false;
      this.lastEventStreamError = toErrorMessage(error);
      this.status = this.createLocalStatus(this.status, [
        `Guest event stream is unavailable: ${this.lastEventStreamError}`,
      ]);
    }
  }

  private stopEventStream() {
    this.eventStreamAbortController?.abort();
    this.eventStreamAbortController = null;
    this.eventStreamTask = null;
    this.remoteEventsEnabled = false;
  }

  private async consumeEventStream(
    stream: ReadableStream<Uint8Array>,
    signal: AbortSignal,
  ) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
            continue;
          }

          if (line.length === 0 && dataLines.length > 0) {
            this.handleEventEnvelope(JSON.parse(dataLines.join("\n")) as GuestAgentEventEnvelope);
            dataLines = [];
          }
        }

        if (signal.aborted) {
          return;
        }
      }

      const tail = decoder.decode();
      if (tail) {
        buffer += tail;
      }

      if (buffer.trim().length > 0 && buffer.startsWith("data:")) {
        dataLines.push(buffer.slice(5).trimStart());
      }

      if (dataLines.length > 0) {
        this.handleEventEnvelope(JSON.parse(dataLines.join("\n")) as GuestAgentEventEnvelope);
      }

      if (!signal.aborted) {
        throw new Error("Guest event stream ended unexpectedly.");
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleEventEnvelope(envelope: GuestAgentEventEnvelope) {
    const nextStatus = {
      ...clone(envelope.status),
      guestPowerState: "running" as const,
    };

    const connectedGuestName =
      envelope.status.connectedGuestName ?? this.status.connectedGuestName;

    if (connectedGuestName) {
      nextStatus.connectedGuestName = connectedGuestName;
    } else {
      delete nextStatus.connectedGuestName;
    }

    this.status = this.createLocalStatus(nextStatus);

    if (envelope.event.type === "session.ended" && envelope.event.sessionId) {
      const session = this.sessions.find((candidate) => candidate.id === envelope.event.sessionId);

      if (session) {
        session.runtimeState = "ended";
        session.streamState = "unavailable";
        session.endedAt ??= envelope.event.createdAt;
      }
    }

    this.appendEvent(envelope.event);
  }

  private createLocalStatus(
    base: GuestStatusSnapshot,
    extraWarnings: string[] = [],
  ): GuestStatusSnapshot {
    return {
      ...base,
      warnings: unique([
        "Managed VM provider is selected.",
        "VM lifecycle orchestration is not implemented yet; the guest agent must already be reachable.",
        `Configured VM name: ${this.config.managedVm.vmName}`,
        `Configured guest agent URL: ${this.config.managedVm.guestAgentBaseUrl}`,
        ...base.warnings,
        ...extraWarnings,
      ]),
    };
  }

  private applyRemoteHealth(response: GuestAgentHealthResponse) {
    this.guestAgentReachable = true;
    this.lastGuestAgentError = null;
    this.status = this.createLocalStatus({
      ...clone(response.status),
      guestPowerState: "running",
      connectedGuestName: response.status.connectedGuestName ?? response.guestName,
    });
  }

  private replaceGames(games: GameRecord[]) {
    this.games.splice(0, this.games.length, ...clone(games));
  }

  private upsertSession(session: GameSession) {
    const existingIndex = this.sessions.findIndex((candidate) => candidate.id === session.id);

    if (existingIndex === -1) {
      this.sessions.unshift(clone(session));
      return;
    }

    this.sessions[existingIndex] = clone(session);
  }

  private pushLocalEvent(
    type: SessionEvent["type"],
    message: string,
    level: SessionEvent["level"] = "info",
    refs: Pick<SessionEvent, "gameId" | "sessionId"> = {},
  ) {
    if (this.remoteEventsEnabled) {
      return;
    }

    this.pushEvent(type, message, level, refs);
  }

  private async fetch(
    path: string,
    init?: RequestInit,
    allowNotFound = false,
  ): Promise<Response> {
    const url = new URL(path, this.config.managedVm.guestAgentBaseUrl).toString();
    const response = await this.fetchImpl(url, init);

    if (!response.ok && !(allowNotFound && response.status === 404)) {
      const body = await response.text();
      throw new Error(`${response.status} ${response.statusText}${body ? `: ${body}` : ""}`);
    }

    return response;
  }

  private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetch(path, init);
    return (await response.json()) as T;
  }

  private pushEvent(
    type: SessionEvent["type"],
    message: string,
    level: SessionEvent["level"] = "info",
    refs: Pick<SessionEvent, "gameId" | "sessionId"> = {},
  ) {
    const event: SessionEvent = {
      id: randomUUID(),
      type,
      level,
      createdAt: now(),
      message,
      ...refs,
    };

    this.appendEvent(event);
  }

  private appendEvent(event: SessionEvent) {
    this.events.unshift(clone(event));
    this.status.lastEventAt = event.createdAt;
    this.emitter.emit("event", clone(event), this.snapshot());
  }
}
