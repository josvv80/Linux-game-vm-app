import type {
  DashboardSnapshot,
  HostConfig,
  HostConfigPatch,
  GuestStatusSnapshot,
  SessionEvent,
} from "@game-vm-hub/shared-types";
import { ConfigStore, defaultHostConfig } from "./config-store.js";
import { createRuntimeController, type RuntimeController } from "./runtime-controller-factory.js";

export class AppState {
  private controller: RuntimeController;
  private config: HostConfig;
  private unsubscribeFromController: (() => void) | null = null;
  private readonly listeners = new Set<(event: SessionEvent, snapshot: DashboardSnapshot) => void>();
  private readonly ready: Promise<void>;

  constructor(
    private readonly configStore = new ConfigStore("data/host-config.json"),
    initialConfig: HostConfig = defaultHostConfig,
  ) {
    this.config = initialConfig;
    this.controller = createRuntimeController(initialConfig);
    this.bindController();
    this.ready = this.initialize();
  }

  private async initialize() {
    this.config = await this.configStore.read();
    this.setController(createRuntimeController(this.config));
  }

  private bindController() {
    this.unsubscribeFromController = this.controller.subscribe((event, snapshot) => {
      for (const listener of this.listeners) {
        listener(event, snapshot);
      }
    });
  }

  private setController(controller: RuntimeController) {
    this.unsubscribeFromController?.();
    this.controller = controller;
    this.bindController();
  }

  private async ensureReady() {
    await this.ready;
  }

  snapshot(): DashboardSnapshot {
    return this.controller.snapshot();
  }

  async status(): Promise<GuestStatusSnapshot> {
    await this.ensureReady();
    return this.controller.runtimeProvider.getStatus();
  }

  async startRuntime(): Promise<GuestStatusSnapshot> {
    await this.ensureReady();
    return this.controller.runtimeProvider.startGuest();
  }

  async stopRuntime(force = false): Promise<GuestStatusSnapshot> {
    await this.ensureReady();
    return this.controller.runtimeProvider.stopGuest(force);
  }

  async scanCatalog() {
    await this.ensureReady();
    return this.controller.guestConnection.scanGames();
  }

  async listGames() {
    await this.ensureReady();
    return this.controller.guestConnection.listGames();
  }

  async getGame(gameId: string) {
    await this.ensureReady();
    return this.snapshot().games.find((game) => game.id === gameId) ?? null;
  }

  async createSession(gameId: string) {
    await this.ensureReady();
    return this.controller.guestConnection.launchGame(gameId);
  }

  async terminateSession(sessionId: string) {
    await this.ensureReady();
    return this.controller.guestConnection.terminateSession(sessionId);
  }

  async attachDisplay() {
    await this.ensureReady();
    return this.controller.runtimeProvider.attachDisplay();
  }

  async diagnostics() {
    await this.ensureReady();
    return this.controller.runtimeProvider.getDiagnostics();
  }

  async getConfig() {
    await this.ensureReady();
    return structuredClone(this.config);
  }

  async updateConfig(patch: HostConfigPatch) {
    await this.ensureReady();
    this.config = await this.configStore.write(patch);
    this.setController(createRuntimeController(this.config));
    return this.getConfig();
  }

  subscribe(listener: (event: SessionEvent, snapshot: DashboardSnapshot) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function createAppState(): AppState {
  return new AppState();
}
