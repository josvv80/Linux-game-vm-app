import { useDeferredValue, useEffect, useEffectEvent, useMemo, useState, startTransition } from "react";
import type {
  DashboardMessage,
  DashboardSnapshot,
  GameRecord,
  GameSession,
  GuestStatusSnapshot,
  HostConfig,
  LauncherId,
  RuntimeDiagnostics,
  SessionEvent,
  RuntimeProviderId,
} from "@game-vm-hub/shared-types";

type RuntimeAction = "start" | "stop" | "scan" | "recover";

const emptySnapshot: DashboardSnapshot = {
  status: {
    guestPowerState: "offline",
    agentState: "offline",
    streamHostState: "unavailable",
    scanState: "idle",
    warnings: ["Host has not connected to a guest yet."],
  },
  games: [],
  sessions: [],
  events: [],
};

function formatTime(value?: string) {
  if (!value) {
    return "n/a";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function statusTone(status: GuestStatusSnapshot) {
  if (status.agentState === "error" || status.scanState === "error") {
    return "danger";
  }

  if (status.activeSessionId) {
    return "success";
  }

  if (status.guestPowerState === "running") {
    return "warning";
  }

  return "neutral";
}

function deriveRecoveryState(
  config: HostConfig,
  diagnostics: RuntimeDiagnostics,
  status: GuestStatusSnapshot,
  latestSession: GameSession | undefined,
) {
  if (config.runtimeProvider !== "managed-vm") {
    return null;
  }

  if (latestSession?.runtimeState === "failed") {
    return {
      tone: "danger" as const,
      title: "Guest launch failed",
      detail:
        latestSession.lastError ??
        diagnostics.lastSessionError ??
        "The Windows guest reported a failed launch before remote play became ready.",
      action: diagnostics.guestAgentReachable ? ("recover" as const) : ("start" as const),
      actionLabel: diagnostics.guestAgentReachable ? "Recover link" : "Start guest",
    };
  }

  if (!diagnostics.guestAgentReachable) {
    return {
      tone: "danger" as const,
      title: "Guest agent offline",
      detail:
        "The Linux host cannot reach the Windows guest agent. Start the guest first or verify the guest agent URL before trying to stream.",
      action: "start" as const,
      actionLabel: "Start guest",
    };
  }

  if (!diagnostics.eventStreamConnected) {
    return {
      tone: "warning" as const,
      title: "Control link degraded",
      detail:
        "The guest is reachable, but the host event stream is disconnected. Remote play may still be booting or the guest-side stream link may need recovery.",
      action: "recover" as const,
      actionLabel: "Recover link",
    };
  }

  if (status.streamHostState !== "ready") {
    return {
      tone: "warning" as const,
      title: "Remote play not ready",
      detail:
        "The guest control path is alive, but the stream handoff is not ready yet. Wait for Sunshine readiness or retry recovery if this state stalls.",
      action: "recover" as const,
      actionLabel: "Retry stream link",
    };
  }

  return {
    tone: "success" as const,
    title: "Remote play path ready",
    detail:
      "The guest is reachable, the event stream is connected, and the remote-play handoff is ready for Moonlight or another client.",
    action: null,
    actionLabel: null,
  };
}

const defaultConfig: HostConfig = {
  runtimeProvider: "fake",
  managedVm: {
    vmName: "win11-gaming",
    guestAgentBaseUrl: "http://127.0.0.1:8765",
    streamMode: "sunshine-moonlight",
  },
};

const defaultDiagnostics: RuntimeDiagnostics = {
  warnings: [],
  sessionCount: 0,
};

async function postJson<T>(path: string, body?: object): Promise<T> {
  const requestInit: RequestInit = {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
  };

  if (body) {
    requestInit.body = JSON.stringify(body);
  }

  const response = await fetch(path, {
    ...requestInit,
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function App() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);
  const [config, setConfig] = useState<HostConfig>(defaultConfig);
  const [search, setSearch] = useState("");
  const [launcherFilter, setLauncherFilter] = useState<LauncherId | "all">("all");
  const [busyAction, setBusyAction] = useState<RuntimeAction | "launch" | "terminate" | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics>(defaultDiagnostics);

  const deferredSearch = useDeferredValue(search);

  const applySnapshot = useEffectEvent((nextSnapshot: DashboardSnapshot) => {
    startTransition(() => {
      setSnapshot(nextSnapshot);
    });
  });

  const refreshDiagnostics = useEffectEvent(async (reportErrors = false) => {
    try {
      const nextDiagnostics = (await fetch("/api/diagnostics").then((response) =>
        response.json(),
      )) as RuntimeDiagnostics;

      startTransition(() => {
        setDiagnostics(nextDiagnostics);
      });
    } catch (error) {
      if (reportErrors) {
        setErrorMessage((error as Error).message);
      }
    }
  });

  useEffect(() => {
    let active = true;

    async function loadInitialState() {
      const [status, games, sessions, diagnostics] = await Promise.all([
        fetch("/api/status").then((response) => response.json()) as Promise<GuestStatusSnapshot>,
        fetch("/api/catalog/games").then((response) => response.json()) as Promise<GameRecord[]>,
        fetch("/api/sessions").then((response) => response.json()) as Promise<GameSession[]>,
        fetch("/api/diagnostics").then((response) => response.json()) as Promise<RuntimeDiagnostics>,
      ]);
      const nextConfig = (await fetch("/api/config").then((response) => response.json())) as HostConfig;

      if (!active) {
        return;
      }

      setConfig(nextConfig);
      setDiagnostics(diagnostics);
      setSnapshot((current) => ({
        status,
        games,
        sessions,
        events: current.events,
      }));
    }

    void loadInitialState().catch((error: Error) => {
      if (active) {
        setErrorMessage(error.message);
      }
    });

    return () => {
      active = false;
    };
  }, [applySnapshot]);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`);

    socket.onmessage = (message) => {
      const parsed = JSON.parse(message.data) as DashboardMessage;
      applySnapshot(parsed.payload);
    };

    socket.onerror = () => {
      setErrorMessage("WebSocket connection to the host API failed.");
    };

    return () => {
      socket.close();
    };
  }, [applySnapshot]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshDiagnostics(false);
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshDiagnostics]);

  const filteredGames = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();

    return snapshot.games.filter((game) => {
      const launcherMatches = launcherFilter === "all" || game.launcher === launcherFilter;
      const titleMatches = !query || game.title.toLowerCase().includes(query);
      return launcherMatches && titleMatches;
    });
  }, [deferredSearch, launcherFilter, snapshot.games]);

  const activeSession = snapshot.sessions.find(
    (session) =>
      session.id === snapshot.status.activeSessionId &&
      (session.runtimeState === "launching" || session.runtimeState === "running"),
  );
  const latestSession = snapshot.sessions[0];
  const recoveryState = deriveRecoveryState(config, diagnostics, snapshot.status, latestSession);

  async function runAction(action: RuntimeAction) {
    setBusyAction(action);
    setErrorMessage(null);

    try {
      if (action === "start") {
        await postJson("/api/runtime/start");
      } else if (action === "recover") {
        await postJson("/api/runtime/recover");
      } else if (action === "stop") {
        await postJson("/api/runtime/stop", { force: true });
      } else {
        await postJson("/api/catalog/scan");
      }
      await refreshDiagnostics(false);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function launchGame(gameId: string) {
    setBusyAction("launch");
    setErrorMessage(null);

    try {
      await postJson("/api/sessions", { gameId });
      await refreshDiagnostics(false);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function terminateSession(sessionId: string) {
    setBusyAction("terminate");
    setErrorMessage(null);

    try {
      await postJson(`/api/sessions/${sessionId}/terminate`);
      await refreshDiagnostics(false);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setBusyAction(null);
    }
  }

  async function saveConfig(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSavingConfig(true);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(config),
      });

      if (!response.ok) {
        throw new Error(`Config update failed: ${response.status}`);
      }

      setConfig((await response.json()) as HostConfig);
      await refreshDiagnostics(false);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setSavingConfig(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Linux host control plane</p>
          <h1>Game VM Hub</h1>
          <p className="lede">
            Prototype dashboard for launching Windows guest games from a Linux appliance-style
            control surface.
          </p>
        </div>
        <div className={`status-card tone-${statusTone(snapshot.status)}`}>
          <span>Guest power</span>
          <strong>{snapshot.status.guestPowerState}</strong>
          <span>Agent {snapshot.status.agentState}</span>
          <span>Stream {snapshot.status.streamHostState}</span>
        </div>
      </section>

      {recoveryState ? (
        <section className={`recovery-banner tone-${recoveryState.tone}`}>
          <div>
            <p className="panel-kicker">Remote Play State</p>
            <h2>{recoveryState.title}</h2>
            <p>{recoveryState.detail}</p>
          </div>
          {recoveryState.action ? (
            <button
              disabled={
                busyAction !== null ||
                (recoveryState.action === "recover" &&
                  (!diagnostics.guestAgentReachable || Boolean(diagnostics.eventStreamConnected)))
              }
              onClick={() => void runAction(recoveryState.action)}
            >
              {recoveryState.actionLabel}
            </button>
          ) : (
            <span className="recovery-ok">Moonlight-side launch path is clear.</span>
          )}
        </section>
      ) : null}

      <section className="grid">
        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">System</p>
              <h2>Runtime Controls</h2>
            </div>
            <span className="badge">{snapshot.status.connectedGuestName ?? "No guest"}</span>
          </div>
          <div className="button-row">
            <button disabled={busyAction !== null} onClick={() => void runAction("start")}>
              Start guest
            </button>
            <button
              disabled={
                busyAction !== null ||
                !diagnostics.guestAgentReachable ||
                Boolean(diagnostics.eventStreamConnected)
              }
              onClick={() => void runAction("recover")}
            >
              Recover link
            </button>
            <button disabled={busyAction !== null} onClick={() => void runAction("scan")}>
              Scan catalog
            </button>
            <button disabled={busyAction !== null} onClick={() => void runAction("stop")}>
              Stop guest
            </button>
          </div>
          <dl className="metrics">
            <div>
              <dt>Scan state</dt>
              <dd>{snapshot.status.scanState}</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>{config.runtimeProvider}</dd>
            </div>
            <div>
              <dt>Catalog size</dt>
              <dd>{snapshot.games.length}</dd>
            </div>
          </dl>
          <div className="diagnostic-list">
            <div className="diagnostic-item">
              <span>Guest agent</span>
              <strong>{diagnostics.guestAgentReachable ? "reachable" : "offline"}</strong>
            </div>
            <div className="diagnostic-item">
              <span>Event stream</span>
              <strong>{diagnostics.eventStreamConnected ? "connected" : "not connected"}</strong>
            </div>
            <div className="diagnostic-item">
              <span>Remote play</span>
              <strong>{diagnostics.remotePlayReady ? "ready" : "waiting"}</strong>
            </div>
            <div className="diagnostic-item">
              <span>Last failure</span>
              <strong>
                {diagnostics.lastEventStreamError ??
                  diagnostics.lastGuestAgentError ??
                  diagnostics.lastSessionError ??
                  diagnostics.lastScanError ??
                  "none"}
              </strong>
            </div>
          </div>
          {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}
          <form className="config-form" onSubmit={(event) => void saveConfig(event)}>
            <label>
              Runtime provider
              <select
                value={config.runtimeProvider}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    runtimeProvider: event.target.value as RuntimeProviderId,
                  }))
                }
              >
                <option value="fake">fake</option>
                <option value="managed-vm">managed-vm</option>
              </select>
            </label>
            <label>
              VM name
              <input
                value={config.managedVm.vmName}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    managedVm: {
                      ...current.managedVm,
                      vmName: event.target.value,
                    },
                  }))
                }
              />
            </label>
            <label>
              Guest agent URL
              <input
                value={config.managedVm.guestAgentBaseUrl}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    managedVm: {
                      ...current.managedVm,
                      guestAgentBaseUrl: event.target.value,
                    },
                  }))
                }
              />
            </label>
            <button disabled={savingConfig || busyAction !== null} type="submit">
              Save config
            </button>
          </form>
          <div className="warning-list">
            {snapshot.status.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Library</p>
              <h2>Game Catalog</h2>
            </div>
          </div>
          <div className="toolbar">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search titles"
            />
            <select
              value={launcherFilter}
              onChange={(event) => setLauncherFilter(event.target.value as LauncherId | "all")}
            >
              <option value="all">All launchers</option>
              <option value="steam">Steam</option>
              <option value="ubisoft-connect">Ubisoft Connect</option>
              <option value="manual">Manual</option>
            </select>
          </div>
          <div className="game-list">
            {filteredGames.map((game) => (
              <div key={game.id} className="game-card">
                <div>
                  <p className="game-title">{game.title}</p>
                  <p className="game-subtitle">
                    {game.launcher} · {game.installState}
                  </p>
                </div>
                <div className="game-footer">
                  <div className="chip-row">
                    {game.compatibilityFlags.map((flag) => (
                      <span key={flag} className="chip">
                        {flag}
                      </span>
                    ))}
                  </div>
                  <button
                    disabled={busyAction !== null}
                    onClick={() => void launchGame(game.id)}
                  >
                    Launch
                  </button>
                </div>
              </div>
            ))}
            {filteredGames.length === 0 ? <p className="empty-state">No games match the filter.</p> : null}
          </div>
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Session</p>
              <h2>Launch Timeline</h2>
            </div>
            {activeSession ? (
              <button disabled={busyAction !== null} onClick={() => void terminateSession(activeSession.id)}>
                Terminate
              </button>
            ) : null}
          </div>
          <div className="session-summary">
            <div>
              <span>State</span>
              <strong>{activeSession?.runtimeState ?? "idle"}</strong>
            </div>
            <div>
              <span>Stream</span>
              <strong>{activeSession?.streamState ?? snapshot.status.streamHostState}</strong>
            </div>
            <div>
              <span>Last event</span>
              <strong>{formatTime(snapshot.status.lastEventAt)}</strong>
            </div>
          </div>
          <div className="contract-card">
            <span>Guest agent target</span>
            <strong>{config.managedVm.guestAgentBaseUrl}</strong>
            <span>Stream mode {config.managedVm.streamMode}</span>
            <span>Diagnostics guest {diagnostics.connectedGuestName ?? "unknown"}</span>
          </div>
          <div className="event-list">
            {snapshot.events.map((event: SessionEvent) => (
              <div key={event.id} className={`event event-${event.level}`}>
                <span>{formatTime(event.createdAt)}</span>
                <p>{event.message}</p>
              </div>
            ))}
            {snapshot.events.length === 0 ? <p className="empty-state">No session events yet.</p> : null}
          </div>
        </article>
      </section>
    </main>
  );
}
