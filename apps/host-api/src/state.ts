import type {
  CatalogGameMetadata,
  DashboardSnapshot,
  HostConfig,
  HostConfigPatch,
  GuestStatusSnapshot,
  SessionEvent,
  SimulationUpdateRequest,
  StreamProbeRequest,
} from "@game-vm-hub/shared-types";
import { ConfigStore, defaultHostConfig } from "./config-store.js";
import {
  createRuntimeController,
  type RuntimeController,
  type RuntimeControllerFactory,
} from "./runtime-controller-factory.js";
import { SteamStoreService } from "./steam-store.js";
import { TheGamesDbService } from "./thegamesdb.js";

export class AppState {
  private controller: RuntimeController;
  private config: HostConfig;
  private unsubscribeFromController: (() => void) | null = null;
  private readonly listeners = new Set<(event: SessionEvent, snapshot: DashboardSnapshot) => void>();
  private readonly ready: Promise<void>;
  private readonly theGamesDbService: TheGamesDbService;
  private readonly steamStoreService: SteamStoreService;

  constructor(
    private readonly configStore = new ConfigStore("data/host-config.json"),
    initialConfig: HostConfig = defaultHostConfig,
    private readonly runtimeControllerFactory: RuntimeControllerFactory = createRuntimeController,
    theGamesDbService = new TheGamesDbService(),
    steamStoreService = new SteamStoreService(),
  ) {
    this.config = initialConfig;
    this.controller = this.runtimeControllerFactory(initialConfig);
    this.theGamesDbService = theGamesDbService;
    this.steamStoreService = steamStoreService;
    this.bindController();
    this.ready = this.initialize();
  }

  private async initialize() {
    this.config = await this.configStore.read();
    this.setController(this.runtimeControllerFactory(this.config));
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

  async prepareRuntime(): Promise<GuestStatusSnapshot> {
    await this.ensureReady();
    return this.controller.runtimeProvider.prepare();
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

  async getCatalogGameMetadata(gameId: string): Promise<CatalogGameMetadata | null> {
    await this.ensureReady();

    const game = this.snapshot().games.find((candidate) => candidate.id === gameId);

    if (!game) {
      return null;
    }

    const [providerMetadata, trailerRef] = await Promise.all([
      this.theGamesDbService.getMetadata(game, this.config.metadataProviders.theGamesDbApiKey),
      this.steamStoreService.getTrailerUrl(game),
    ]);

    if (!providerMetadata && !trailerRef) {
      return null;
    }

    if (!providerMetadata) {
      const metadata: CatalogGameMetadata = {
        source: "steam-store",
      };

      if (trailerRef) {
        metadata.trailerRef = trailerRef;
      }

      return metadata;
    }

    const metadata: CatalogGameMetadata = {
      ...providerMetadata,
      source: trailerRef ? "composite" : providerMetadata.source,
    };

    if (trailerRef) {
      metadata.trailerRef = trailerRef;
    } else if (providerMetadata.trailerRef) {
      metadata.trailerRef = providerMetadata.trailerRef;
    }

    return metadata;
  }

  async createSession(gameId: string) {
    await this.ensureReady();
    return this.controller.guestConnection.launchGame(gameId);
  }

  async getSimulationCatalog() {
    await this.ensureReady();
    return this.controller.guestConnection.getSimulationCatalog();
  }

  async updateSimulation(request: SimulationUpdateRequest) {
    await this.ensureReady();
    return this.controller.guestConnection.updateSimulation(request);
  }

  async probeStreamHost(request: StreamProbeRequest) {
    await this.ensureReady();
    return this.controller.guestConnection.probeStreamHost(request);
  }

  async terminateSession(sessionId: string) {
    await this.ensureReady();
    return this.controller.guestConnection.terminateSession(sessionId);
  }

  async recoverSession() {
    await this.ensureReady();

    const currentSnapshot = this.snapshot();
    const activeSession = currentSnapshot.sessions.find(
      (session) =>
        session.id === currentSnapshot.status.activeSessionId &&
        (session.runtimeState === "launching" || session.runtimeState === "running"),
    );
    const failedSession = currentSnapshot.sessions.find(
      (session) => session.runtimeState === "failed",
    );
    const candidate = activeSession ?? failedSession;

    if (!candidate) {
      throw new Error("No stalled or failed session is available for recovery.");
    }

    if (activeSession) {
      await this.controller.guestConnection.terminateSession(activeSession.id);
    }

    await this.controller.runtimeProvider.prepare();
    return this.controller.guestConnection.launchGame(candidate.gameId);
  }

  async attachDisplay() {
    await this.ensureReady();
    return this.controller.runtimeProvider.attachDisplay();
  }

  async detachDisplay() {
    await this.ensureReady();
    return this.controller.runtimeProvider.detachDisplay();
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
    this.theGamesDbService.clear();
    this.steamStoreService.clear();
    this.setController(this.runtimeControllerFactory(this.config));
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
