export type LauncherId = "steam" | "ubisoft-connect" | "manual";
export type RuntimeProviderId = "fake" | "managed-vm";

export type InstallState = "installed" | "not-installed" | "launcher-missing";

export type RuntimePowerState = "offline" | "starting" | "running" | "stopping";

export type AgentState = "offline" | "booting" | "online" | "scanning" | "ready" | "error";

export type StreamState = "unavailable" | "preparing" | "ready";

export type ScanState = "idle" | "running" | "complete" | "error";

export type SessionRuntimeState =
  | "queued"
  | "launching"
  | "running"
  | "ended"
  | "failed"
  | "terminated";

export type CompatibilityFlag =
  | "prototype"
  | "single-gpu-vfio-risk"
  | "anti-cheat-unknown";

export type EventLevel = "info" | "error";

export interface GameRecord {
  id: string;
  title: string;
  launcher: LauncherId;
  installState: InstallState;
  launchCommandRef: string;
  coverArtRef?: string;
  lastSeenAt: string;
  compatibilityFlags: CompatibilityFlag[];
  guestMetadata: Record<string, string>;
}

export interface GameSession {
  id: string;
  gameId: string;
  runtimeState: SessionRuntimeState;
  guestState: AgentState;
  streamState: StreamState;
  startedAt: string;
  endedAt?: string;
  lastError?: string;
}

export interface GuestStatusSnapshot {
  guestPowerState: RuntimePowerState;
  agentState: AgentState;
  streamHostState: StreamState;
  scanState: ScanState;
  activeSessionId?: string;
  warnings: string[];
  lastEventAt?: string;
  connectedGuestName?: string;
}

export type SessionEventType =
  | "guest.connected"
  | "guest.disconnected"
  | "guest.scan.started"
  | "guest.scan.completed"
  | "guest.scan.failed"
  | "session.launch.requested"
  | "session.launch.started"
  | "session.game.detected"
  | "session.streaming.ready"
  | "session.ended"
  | "session.failed";

export interface SessionEvent {
  id: string;
  type: SessionEventType;
  level: EventLevel;
  createdAt: string;
  message: string;
  gameId?: string;
  sessionId?: string;
}

export interface LaunchRequest {
  gameId: string;
}

export interface LaunchResult {
  session: GameSession;
}

export interface RuntimeDiagnostics {
  warnings: string[];
  sessionCount: number;
}

export interface RuntimeProvider {
  getStatus(): Promise<GuestStatusSnapshot>;
  prepare(): Promise<GuestStatusSnapshot>;
  startGuest(): Promise<GuestStatusSnapshot>;
  stopGuest(force?: boolean): Promise<GuestStatusSnapshot>;
  attachDisplay(): Promise<{ ok: boolean; detail: string }>;
  getDiagnostics(): Promise<RuntimeDiagnostics>;
}

export interface GuestConnection {
  getHealth(): Promise<GuestStatusSnapshot>;
  scanGames(): Promise<GameRecord[]>;
  listGames(): Promise<GameRecord[]>;
  launchGame(gameId: string): Promise<LaunchResult>;
  terminateSession(sessionId: string): Promise<GameSession | null>;
}

export interface DashboardSnapshot {
  status: GuestStatusSnapshot;
  games: GameRecord[];
  sessions: GameSession[];
  events: SessionEvent[];
}

export interface ManagedVmConfig {
  vmName: string;
  guestAgentBaseUrl: string;
  streamMode: "sunshine-moonlight";
}

export interface HostConfig {
  runtimeProvider: RuntimeProviderId;
  managedVm: ManagedVmConfig;
}

export interface HostConfigPatch {
  runtimeProvider?: RuntimeProviderId;
  managedVm?: Partial<ManagedVmConfig>;
}

export interface GuestAgentHealthResponse {
  guestName: string;
  agentVersion: string;
  status: GuestStatusSnapshot;
}

export interface GuestAgentGameListResponse {
  games: GameRecord[];
  scannedAt: string;
}

export interface GuestAgentLaunchRequest {
  gameId: string;
}

export interface GuestAgentLaunchResponse {
  session: GameSession;
}

export interface GuestAgentEventEnvelope {
  event: SessionEvent;
  status: GuestStatusSnapshot;
}

export interface DashboardEventMessage {
  type: "event";
  event: SessionEvent;
  payload: DashboardSnapshot;
}

export interface DashboardSnapshotMessage {
  type: "snapshot";
  payload: DashboardSnapshot;
}

export type DashboardMessage = DashboardEventMessage | DashboardSnapshotMessage;
