import { EventEmitter } from "node:events";
import type {
  DashboardSnapshot,
  GameRecord,
  GameSession,
  GuestConnection,
  GuestStatusSnapshot,
  HostConfig,
  RuntimeDiagnostics,
  RuntimeProvider,
  SessionEvent,
} from "@game-vm-hub/shared-types";

type EventListener = (event: SessionEvent, snapshot: DashboardSnapshot) => void;

function now(): string {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class ManagedVmController {
  private readonly emitter = new EventEmitter();
  private readonly events: SessionEvent[] = [];
  private readonly sessions: GameSession[] = [];
  private readonly games: GameRecord[] = [];
  private readonly status: GuestStatusSnapshot;

  readonly runtimeProvider: RuntimeProvider;
  readonly guestConnection: GuestConnection;

  constructor(private readonly config: HostConfig) {
    this.status = {
      guestPowerState: "offline",
      agentState: "offline",
      streamHostState: "unavailable",
      scanState: "idle",
      warnings: [
        "Managed VM provider scaffold is selected.",
        "libvirt/QEMU integration is not implemented yet.",
        `Configured VM name: ${config.managedVm.vmName}`,
        `Configured guest agent URL: ${config.managedVm.guestAgentBaseUrl}`,
      ],
    };

    this.runtimeProvider = {
      getStatus: async () => this.getStatus(),
      prepare: async () => this.prepare(),
      startGuest: async () => this.startGuest(),
      stopGuest: async () => this.stopGuest(),
      attachDisplay: async () => this.attachDisplay(),
      getDiagnostics: async () => this.getDiagnostics(),
    };

    this.guestConnection = {
      getHealth: async () => this.getStatus(),
      scanGames: async () => this.scanGames(),
      listGames: async () => this.listGames(),
      launchGame: async () => {
        throw new Error("Managed VM guest launch is not implemented yet.");
      },
      terminateSession: async () => null,
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
    this.pushEvent(
      "guest.disconnected",
      "Managed VM provider prepare requested, but provider is still a scaffold.",
    );
    return this.getStatus();
  }

  async startGuest(): Promise<GuestStatusSnapshot> {
    throw new Error(
      `Managed VM provider is configured for ${this.config.managedVm.vmName}, but startGuest is not implemented yet.`,
    );
  }

  async stopGuest(): Promise<GuestStatusSnapshot> {
    this.pushEvent(
      "guest.disconnected",
      "Managed VM provider stop requested, but no VM orchestration exists yet.",
    );
    return this.getStatus();
  }

  async attachDisplay(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: false,
      detail: "Managed VM display attach is not implemented yet.",
    };
  }

  async getDiagnostics(): Promise<RuntimeDiagnostics> {
    return {
      warnings: [...this.status.warnings],
      sessionCount: this.sessions.length,
    };
  }

  async scanGames(): Promise<GameRecord[]> {
    throw new Error(
      `Managed VM guest scan is not implemented yet. Expected guest agent base URL: ${this.config.managedVm.guestAgentBaseUrl}`,
    );
  }

  async listGames(): Promise<GameRecord[]> {
    return clone(this.games);
  }

  private pushEvent(type: SessionEvent["type"], message: string) {
    const event: SessionEvent = {
      id: crypto.randomUUID(),
      type,
      level: "info",
      createdAt: now(),
      message,
    };

    this.events.unshift(event);
    this.status.lastEventAt = event.createdAt;
    this.emitter.emit("event", clone(event), this.snapshot());
  }
}
