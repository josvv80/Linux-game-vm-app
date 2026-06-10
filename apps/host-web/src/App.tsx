import { useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState, startTransition } from "react";
import { canLaunchGame } from "@game-vm-hub/catalog-core";
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
  SimulationCatalog,
  SimulationGameProfile,
  SimulationOutcome,
  StreamProbeResult,
} from "@game-vm-hub/shared-types";

type RuntimeAction =
  | "start"
  | "stop"
  | "scan"
  | "recover"
  | "recover-session"
  | "attach-display"
  | "detach-display";

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

const emptySimulationCatalog: SimulationCatalog = {
  games: [],
};

function discoverySourceLabel(source?: string) {
  switch (source) {
    case "steam-appmanifest":
      return "real Steam";
    case "sample-steam":
      return "sample Steam";
    case "ubisoft-registry":
      return "real Ubisoft registry";
    case "ubisoft-connect-manifest":
      return "real Ubisoft manifest";
    case "sample-ubisoft":
      return "sample Ubisoft";
    default:
      return "unknown source";
  }
}

function launchStrategyLabel(strategy?: string) {
  switch (strategy) {
    case "steam-handoff-or-simulated-fallback":
      return "Steam handoff";
    case "simulated-only":
      return "simulated";
    default:
      return "unknown launch path";
  }
}

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

function formatDurationMs(value?: number) {
  if (value === undefined) {
    return "n/a";
  }

  if (value < 1000) {
    return `${value}ms`;
  }

  return `${(value / 1000).toFixed(1)}s`;
}

function formatList(values?: Array<string | number>) {
  return values && values.length > 0 ? values.join(", ") : "";
}

function parseStringList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePortList(value: string) {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

function formatMetadataList(value?: string) {
  return value
    ? value
        .split(";")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .join(", ")
    : "";
}

function hasObservedStreamProbeTargets(result: StreamProbeResult) {
  return Boolean(result.processName) || result.listeningPorts.length > 0;
}

function mergeStringTarget(values: string[] | undefined, observed: string) {
  const existingValues = values ?? [];
  const observedKey = observed.trim().toLowerCase();

  if (!observedKey) {
    return existingValues;
  }

  if (existingValues.some((value) => value.trim().toLowerCase() === observedKey)) {
    return existingValues;
  }

  return [...existingValues, observed.trim()];
}

function mergePortTargets(values: number[] | undefined, observed: number[]) {
  const merged = [...(values ?? [])];
  const seen = new Set(merged);

  for (const port of observed) {
    if (!seen.has(port)) {
      merged.push(port);
      seen.add(port);
    }
  }

  return merged;
}

function streamProbeTargetsAlreadyConfigured(
  profile: SimulationGameProfile,
  result: StreamProbeResult,
) {
  if (!result.ok || !hasObservedStreamProbeTargets(result)) {
    return false;
  }

  const configuredProcessNames = new Set(
    (profile.streamProbeProcessNames ?? []).map((processName) =>
      processName.trim().toLowerCase(),
    ),
  );
  const configuredPorts = new Set(profile.streamProbePorts ?? []);
  const processCovered =
    !result.processName ||
    configuredProcessNames.has(result.processName.trim().toLowerCase());
  const portsCovered = result.listeningPorts.every((port) => configuredPorts.has(port));

  return processCovered && portsCovered;
}

function StreamProbeResultPanel({
  result,
  targetsConfigured,
}: {
  result: StreamProbeResult;
  targetsConfigured?: boolean | undefined;
}) {
  return (
    <div className="stream-probe-result">
      <p className={`game-meta-line ${result.ok ? "selected-game-ready" : "selected-game-warning"}`}>
        {result.detail}
      </p>
      <p className="game-meta-line">
        Checked {formatTime(result.checkedAt)} via {result.mode}.
      </p>
      {result.ok ? (
        <p className="game-meta-line">
          Observed {result.processName ? `process ${result.processName}` : "no process name"}{" "}
          with ports {formatList(result.listeningPorts) || "none"}.
        </p>
      ) : null}
      {targetsConfigured !== undefined && result.ok && hasObservedStreamProbeTargets(result) ? (
        <p className="stream-probe-target-state">
          {targetsConfigured
            ? "Observed targets are already covered by this profile."
            : "Observed targets can be added to this profile."}
        </p>
      ) : null}
    </div>
  );
}

function describeStreamProbeTargets(profile: SimulationGameProfile) {
  return `Probe targets reset to provider defaults: processes ${
    formatList(profile.streamProbeProcessNames) || "none"
  }; ports ${formatList(profile.streamProbePorts) || "none"}.`;
}

function launcherLabel(launcher: LauncherId) {
  switch (launcher) {
    case "steam":
      return "Steam";
    case "ubisoft-connect":
      return "Ubisoft Connect";
    case "manual":
      return "Manual";
  }
}

function installStateLabel(state: GameRecord["installState"]) {
  switch (state) {
    case "installed":
      return "Installed";
    case "launcher-missing":
      return "Launcher missing";
    case "not-installed":
      return "Not installed";
  }
}

function gameInitials(title: string) {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

function getSteamArtSources(game: GameRecord, variant: "hero" | "poster") {
  const appId = game.guestMetadata.launcherAppId;

  if (!appId) {
    return [];
  }

  if (variant === "hero") {
    return [
      `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/library_hero.jpg`,
      `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
    ];
  }

  return [
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/library_600x900_2x.jpg`,
    `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg`,
  ];
}

function getGameArtSources(game: GameRecord, variant: "hero" | "poster") {
  const sources: string[] = [];

  if (variant === "hero" && game.guestMetadata.heroArtRef) {
    sources.push(game.guestMetadata.heroArtRef);
  }

  if (game.coverArtRef) {
    sources.push(game.coverArtRef);
  }

  if (game.launcher === "steam") {
    sources.push(...getSteamArtSources(game, variant));
  }

  return [...new Set(sources.filter(Boolean))];
}

function gameDescription(game: GameRecord) {
  switch (game.id) {
    case "steam:app-578080":
      return "Large-scale battle royale with Steam handoff support in the current prototype.";
    case "ubisoft-connect:anno-1800":
      return "City-building and trade management sample used to exercise the Ubisoft path and recovery flow.";
  }

  const source = game.guestMetadata.discoverySource;

  if (game.launcher === "steam") {
    return source === "steam-appmanifest"
      ? "Discovered from your Windows Steam libraries and prepared for host-driven Steam launch handoff."
      : "Steam title present in the prototype catalog for control-surface testing.";
  }

  if (game.launcher === "ubisoft-connect") {
    return source === "ubisoft-registry" || source === "ubisoft-connect-manifest"
      ? "Discovered from Ubisoft Connect install data in the Windows guest. Launch browsing is live; deeper Ubisoft launch execution is still scaffolded."
      : "Ubisoft title present in the prototype catalog for controller-flow and recovery testing.";
  }

  return "Prototype game entry available to validate the host browse and launch surface.";
}

function gameStatusSummary(game: GameRecord, canLaunch: boolean, reason?: string) {
  if (canLaunch) {
    return "Ready to launch from the current guest state.";
  }

  return reason ?? `${launcherLabel(game.launcher)} launch is currently blocked.`;
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function GameArtwork({
  game,
  variant,
  className,
}: {
  game: GameRecord;
  variant: "hero" | "poster";
  className: string;
}) {
  const sources = getGameArtSources(game, variant);
  const sourceKey = sources.join("|");
  const [sourceIndex, setSourceIndex] = useState(0);

  useEffect(() => {
    setSourceIndex(0);
  }, [sourceKey]);

  const activeSource = sources[sourceIndex];

  return (
    <div className={`${className} artwork-shell artwork-${variant} artwork-${game.launcher}`}>
      {activeSource ? (
        <img
          alt=""
          src={activeSource}
          onError={() => {
            setSourceIndex((current) => (current + 1 < sources.length ? current + 1 : sources.length));
          }}
        />
      ) : null}
      {!activeSource ? (
        <div className="artwork-fallback" aria-hidden="true">
          <span>{launcherLabel(game.launcher)}</span>
          <strong>{gameInitials(game.title)}</strong>
        </div>
      ) : null}
    </div>
  );
}

function sessionStateLabel(session: GameSession) {
  if (session.runtimeState === "failed" && session.lastError) {
    return "failed";
  }

  return session.runtimeState;
}

function sessionTone(session: GameSession) {
  if (session.runtimeState === "failed") {
    return "danger";
  }

  if (session.runtimeState === "running" || session.runtimeState === "launching") {
    return "success";
  }

  if (session.runtimeState === "queued") {
    return "warning";
  }

  return "neutral";
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

function eventStreamStateLabel(diagnostics: RuntimeDiagnostics) {
  if (diagnostics.eventStreamState === "reconnecting") {
    const attemptCount = diagnostics.eventStreamReconnectAttempts ?? 0;
    return attemptCount > 0 ? `reconnecting (${attemptCount})` : "reconnecting";
  }

  if (diagnostics.eventStreamState) {
    return diagnostics.eventStreamState;
  }

  return diagnostics.eventStreamConnected ? "connected" : "disconnected";
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
      action: diagnostics.guestAgentReachable
        ? ("recover-session" as const)
        : ("start" as const),
      actionLabel: diagnostics.guestAgentReachable ? "Relaunch game" : "Start guest",
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
    if (diagnostics.eventStreamState === "reconnecting") {
      const attemptCount = diagnostics.eventStreamReconnectAttempts ?? 0;

      return {
        tone: "warning" as const,
        title: "Control link recovering",
        detail:
          attemptCount > 0
            ? `The guest is still reachable and the host is retrying the event stream automatically. Current reconnect attempt: ${attemptCount}.`
            : "The guest is still reachable and the host is retrying the event stream automatically.",
        action: "recover" as const,
        actionLabel: "Retry now",
      };
    }

    return {
      tone: "warning" as const,
      title: "Control link degraded",
      detail:
        "The guest is reachable, but the host event stream is disconnected. Remote play may still be booting or the guest-side stream link may need recovery.",
      action: "recover" as const,
      actionLabel: "Recover link",
    };
  }

  if (!diagnostics.activeSessionRunning) {
    return {
      tone: "warning" as const,
      title: "No active play session",
      detail:
        "The guest control path is available, but no game session is currently running. Launch a game from the library before trying to attach remote play.",
      action: null,
      actionLabel: null,
    };
  }

  if (diagnostics.remotePlayStalled) {
    return {
      tone: "danger" as const,
      title: "Remote play stalled",
      detail:
        diagnostics.remotePlayStallDetail ??
        "The active session has exceeded its expected stream-ready window. Retry the guest control link or relaunch if the stall persists.",
      action: "recover-session" as const,
      actionLabel: "Restart stalled launch",
    };
  }

  if (!diagnostics.activeSessionStreamReady || status.streamHostState !== "ready") {
    return {
      tone: "warning" as const,
      title: "Remote play not ready",
      detail:
        "The guest control path is alive, but the stream handoff is not ready yet. Wait for Sunshine readiness or retry recovery if this state stalls.",
      action: "recover" as const,
      actionLabel: "Retry stream link",
    };
  }

  if (!diagnostics.remoteClientAttached) {
    return {
      tone: "success" as const,
      title: "Remote play ready to attach",
      detail:
        diagnostics.lastDisplayAttachDetail ??
        "The stream path is ready, but no remote client is attached yet. Hand off to Moonlight or another client to begin play.",
      action: "attach-display" as const,
      actionLabel: "Attach display",
    };
  }

  return {
    tone: "success" as const,
    title: "Remote client attached",
    detail:
      diagnostics.lastDisplayAttachDetail ??
      "The guest is reachable, the event stream is connected, and a remote client is attached.",
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
  pinnedGameIds: [],
};

const defaultDiagnostics: RuntimeDiagnostics = {
  warnings: [],
  sessionCount: 0,
};
const dashboardFeedErrorMessage = "WebSocket connection to the host API failed.";

async function postJson<T>(path: string, body?: object): Promise<T> {
  const requestInit: RequestInit = {
    method: "POST",
  };

  if (body) {
    requestInit.headers = {
      "content-type": "application/json",
    };
    requestInit.body = JSON.stringify(body);
  }

  const response = await fetch(path, {
    ...requestInit,
  });

  if (!response.ok) {
    let detail = "";

    try {
      const errorBody = (await response.json()) as { message?: string };
      detail = typeof errorBody.message === "string" ? errorBody.message : "";
    } catch {
      detail = "";
    }

    throw new Error(detail ? `${detail} (${response.status})` : `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function App() {
  const bulkPinnedActionId = "__pinned-bulk__";
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(emptySnapshot);
  const [config, setConfig] = useState<HostConfig>(defaultConfig);
  const [search, setSearch] = useState("");
  const [launcherFilter, setLauncherFilter] = useState<LauncherId | "all">("all");
  const [busyAction, setBusyAction] = useState<RuntimeAction | "launch" | "terminate" | null>(
    null,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [configSaveMessage, setConfigSaveMessage] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);
  const [savingPinnedGameId, setSavingPinnedGameId] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics>(defaultDiagnostics);
  const [simulationCatalog, setSimulationCatalog] =
    useState<SimulationCatalog>(emptySimulationCatalog);
  const [savingSimulationGameId, setSavingSimulationGameId] = useState<string | null>(null);
  const [probingSimulationGameId, setProbingSimulationGameId] = useState<string | null>(null);
  const [streamProbeResultsByGameId, setStreamProbeResultsByGameId] = useState<
    Record<string, StreamProbeResult>
  >({});
  const [streamProbeResetMessagesByGameId, setStreamProbeResetMessagesByGameId] = useState<
    Record<string, string>
  >({});
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [eventFeedMode, setEventFeedMode] = useState<"websocket" | "polling">("websocket");
  const gamepadStateRef = useRef<Record<string, boolean>>({});

  const deferredSearch = useDeferredValue(search);

  const applySnapshot = useEffectEvent((nextSnapshot: DashboardSnapshot) => {
    startTransition(() => {
      setSnapshot(nextSnapshot);
      setErrorMessage((current) =>
        current === dashboardFeedErrorMessage ? null : current,
      );
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

  const refreshSnapshot = useEffectEvent(async (reportErrors = false) => {
    try {
      const response = await fetch("/api/snapshot");

      if (!response.ok) {
        throw new Error(`Snapshot request failed: ${response.status}`);
      }

      applySnapshot((await response.json()) as DashboardSnapshot);
    } catch (error) {
      if (reportErrors) {
        setErrorMessage((error as Error).message);
      }
    }
  });

  const refreshSimulation = useEffectEvent(async (reportErrors = false) => {
    if (config.runtimeProvider !== "managed-vm" || !diagnostics.guestAgentReachable) {
      startTransition(() => {
        setSimulationCatalog(emptySimulationCatalog);
      });
      return;
    }

    try {
      const response = await fetch("/api/simulation");

      if (!response.ok) {
        throw new Error(`Simulation request failed: ${response.status}`);
      }

      const nextCatalog = (await response.json()) as SimulationCatalog;

      startTransition(() => {
        setSimulationCatalog(nextCatalog);
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
      const [nextSnapshot, diagnostics] = await Promise.all([
        fetch("/api/snapshot").then((response) => response.json()) as Promise<DashboardSnapshot>,
        fetch("/api/diagnostics").then((response) => response.json()) as Promise<RuntimeDiagnostics>,
      ]);
      const nextConfig = (await fetch("/api/config").then((response) => response.json())) as HostConfig;

      if (!active) {
        return;
      }

      setConfig(nextConfig);
      setDiagnostics(diagnostics);
      applySnapshot(nextSnapshot);
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
    let active = true;
    let pollingIntervalId: number | null = null;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/events`);

    socket.onmessage = (message) => {
      const parsed = JSON.parse(message.data) as DashboardMessage;
      setEventFeedMode("websocket");
      applySnapshot(parsed.payload);
    };

    const startPollingFallback = () => {
      if (!active) {
        return;
      }

      setEventFeedMode("polling");
      void refreshSnapshot(false);

      if (pollingIntervalId === null) {
        pollingIntervalId = window.setInterval(() => {
          void refreshSnapshot(false);
        }, 3000);
      }
    };

    socket.onerror = () => {
      startPollingFallback();
    };

    socket.onclose = () => {
      startPollingFallback();
    };

    return () => {
      active = false;
      if (pollingIntervalId !== null) {
        window.clearInterval(pollingIntervalId);
      }
      socket.close();
    };
  }, [applySnapshot, refreshSnapshot]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void refreshDiagnostics(false);
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [refreshDiagnostics]);

  useEffect(() => {
    if (config.runtimeProvider !== "managed-vm" || !diagnostics.guestAgentReachable) {
      setSimulationCatalog(emptySimulationCatalog);
      return;
    }

    void refreshSimulation(false);
  }, [config.runtimeProvider, diagnostics.guestAgentReachable, refreshSimulation]);

  const filteredGames = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();

    return snapshot.games.filter((game) => {
      const launcherMatches = launcherFilter === "all" || game.launcher === launcherFilter;
      const titleMatches = !query || game.title.toLowerCase().includes(query);
      return launcherMatches && titleMatches;
    });
  }, [deferredSearch, launcherFilter, snapshot.games]);

  useEffect(() => {
    if (filteredGames.length === 0) {
      setSelectedGameId(null);
      return;
    }

    if (!selectedGameId || !filteredGames.some((game) => game.id === selectedGameId)) {
      setSelectedGameId(filteredGames[0]!.id);
    }
  }, [filteredGames, selectedGameId]);

  const activeSession = snapshot.sessions.find(
    (session) =>
      session.id === snapshot.status.activeSessionId &&
      (session.runtimeState === "launching" || session.runtimeState === "running"),
  );
  const latestSession = snapshot.sessions[0];
  const recoveryState = deriveRecoveryState(config, diagnostics, snapshot.status, latestSession);
  const gameTitlesById = useMemo(
    () => new Map(snapshot.games.map((game) => [game.id, game.title])),
    [snapshot.games],
  );
  const gamesById = useMemo(
    () => new Map(snapshot.games.map((game) => [game.id, game])),
    [snapshot.games],
  );
  const catalogInsights = useMemo(() => {
    const steamLibraryRoots = new Set<string>();
    let realSteamCount = 0;
    let realUbisoftCount = 0;
    let sampleSteamCount = 0;
    let sampleUbisoftCount = 0;
    let unknownCount = 0;

    for (const game of snapshot.games) {
      const source = game.guestMetadata.discoverySource;

      if (source === "steam-appmanifest") {
        realSteamCount += 1;
        if (game.guestMetadata.steamLibraryRoot) {
          steamLibraryRoots.add(game.guestMetadata.steamLibraryRoot);
        }
        continue;
      }

      if (source === "sample-steam") {
        sampleSteamCount += 1;
        continue;
      }

      if (source === "ubisoft-registry" || source === "ubisoft-connect-manifest") {
        realUbisoftCount += 1;
        continue;
      }

      if (source === "sample-ubisoft") {
        sampleUbisoftCount += 1;
        continue;
      }

      unknownCount += 1;
    }

    return {
      realSteamCount,
      realUbisoftCount,
      sampleSteamCount,
      sampleUbisoftCount,
      unknownCount,
      steamLibraryCount: steamLibraryRoots.size,
    };
  }, [snapshot.games]);
  const activeSessionGame = activeSession ? gamesById.get(activeSession.gameId) : undefined;
  const latestSessionGame = latestSession ? gamesById.get(latestSession.gameId) : undefined;
  const launchContextGame = activeSessionGame ?? latestSessionGame;
  const diagnosticsSessionGame = diagnostics.activeSessionId
    ? snapshot.sessions.find((session) => session.id === diagnostics.activeSessionId)
    : undefined;
  const diagnosticsSessionTitle = diagnosticsSessionGame
    ? gameTitlesById.get(diagnosticsSessionGame.gameId) ?? diagnosticsSessionGame.gameId
    : "none";
  const recentSessions = snapshot.sessions.slice(0, 6);
  const launchChecksByGameId = useMemo(
    () => new Map(snapshot.games.map((game) => [game.id, canLaunchGame(game, snapshot.status)])),
    [snapshot.games, snapshot.status],
  );
  const simulationProfilesByGameId = useMemo(
    () => new Map(simulationCatalog.games.map((profile) => [profile.gameId, profile])),
    [simulationCatalog.games],
  );
  const selectedGame = selectedGameId ? gamesById.get(selectedGameId) : filteredGames[0];
  const selectedLaunchCheck = selectedGame
    ? launchChecksByGameId.get(selectedGame.id) ?? canLaunchGame(selectedGame, snapshot.status)
    : null;
  const selectedSimulationProfile = selectedGame
    ? simulationProfilesByGameId.get(selectedGame.id)
    : undefined;
  const selectedStreamProbeResult = selectedGame
    ? streamProbeResultsByGameId[selectedGame.id]
    : undefined;
  const selectedStreamProbeResetMessage = selectedGame
    ? streamProbeResetMessagesByGameId[selectedGame.id]
    : undefined;
  const selectedStreamProbeTargetsConfigured =
    selectedSimulationProfile && selectedStreamProbeResult
      ? streamProbeTargetsAlreadyConfigured(
          selectedSimulationProfile,
          selectedStreamProbeResult,
        )
      : false;
  const pinnedEntries = useMemo(
    () =>
      config.pinnedGameIds.map((gameId) => {
        const game = gamesById.get(gameId);

        return {
          gameId,
          game,
          launchCheck: game
            ? launchChecksByGameId.get(game.id) ?? canLaunchGame(game, snapshot.status)
            : null,
          missing: !game,
        };
      }),
    [config.pinnedGameIds, gamesById, launchChecksByGameId, snapshot.status],
  );
  const missingPinnedCount = pinnedEntries.filter((entry) => entry.missing).length;
  const selectedGameIndex = selectedGame
    ? filteredGames.findIndex((game) => game.id === selectedGame.id)
    : -1;

  const moveSelectedGame = useEffectEvent((direction: -1 | 1) => {
    if (filteredGames.length === 0) {
      return;
    }

    const baseIndex = selectedGameIndex >= 0 ? selectedGameIndex : 0;
    const nextIndex = (baseIndex + direction + filteredGames.length) % filteredGames.length;
    setSelectedGameId(filteredGames[nextIndex]!.id);
  });

  const launchSelectedGame = useEffectEvent(() => {
    if (!selectedGame || !selectedLaunchCheck?.canLaunch || busyAction !== null) {
      return;
    }

    void launchGame(selectedGame.id);
  });

  const pinSelectedGame = useEffectEvent(() => {
    if (!selectedGame || busyAction !== null || savingPinnedGameId === selectedGame.id) {
      return;
    }

    void togglePinnedGame(selectedGame.id);
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || isTypingTarget(event.target)) {
        return;
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveSelectedGame(-1);
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveSelectedGame(1);
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        launchSelectedGame();
        return;
      }

      if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        pinSelectedGame();
      }
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [launchSelectedGame, moveSelectedGame, pinSelectedGame]);

  useEffect(() => {
    let frameId = 0;

    const updatePressedState = (key: string, active: boolean, action: () => void) => {
      const wasActive = gamepadStateRef.current[key] ?? false;

      if (active && !wasActive) {
        action();
      }

      gamepadStateRef.current[key] = active;
    };

    const pollGamepad = () => {
      if (!isTypingTarget(document.activeElement)) {
        const gamepad = navigator.getGamepads?.().find(Boolean);

        if (gamepad) {
          const horizontalAxis = gamepad.axes[0] ?? 0;

          updatePressedState(
            "left",
            Boolean(gamepad.buttons[14]?.pressed) || horizontalAxis < -0.65,
            () => moveSelectedGame(-1),
          );
          updatePressedState(
            "right",
            Boolean(gamepad.buttons[15]?.pressed) || horizontalAxis > 0.65,
            () => moveSelectedGame(1),
          );
          updatePressedState(
            "launch",
            Boolean(gamepad.buttons[0]?.pressed),
            () => launchSelectedGame(),
          );
          updatePressedState(
            "pin",
            Boolean(gamepad.buttons[3]?.pressed),
            () => pinSelectedGame(),
          );
        } else {
          gamepadStateRef.current = {};
        }
      }

      frameId = window.requestAnimationFrame(pollGamepad);
    };

    frameId = window.requestAnimationFrame(pollGamepad);

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [launchSelectedGame, moveSelectedGame, pinSelectedGame]);

  async function runAction(action: RuntimeAction) {
    setBusyAction(action);
    setErrorMessage(null);

    try {
      if (action === "start") {
        await postJson("/api/runtime/start");
      } else if (action === "recover") {
        await postJson("/api/runtime/recover");
      } else if (action === "recover-session") {
        await postJson("/api/runtime/recover-session");
      } else if (action === "attach-display") {
        const response = await postJson<{ ok: boolean; detail: string }>(
          "/api/runtime/attach-display",
        );

        if (!response.ok) {
          throw new Error(response.detail);
        }
      } else if (action === "detach-display") {
        const response = await postJson<{ ok: boolean; detail: string }>(
          "/api/runtime/detach-display",
        );

        if (!response.ok) {
          throw new Error(response.detail);
        }
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
    setConfigSaveMessage(null);

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

      const savedConfig = (await response.json()) as HostConfig;
      setConfig(savedConfig);
      setConfigSaveMessage(
        `Config saved: ${savedConfig.runtimeProvider} using ${savedConfig.managedVm.vmName} at ${savedConfig.managedVm.guestAgentBaseUrl}.`,
      );
      await refreshDiagnostics(false);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setSavingConfig(false);
    }
  }

  async function updatePinnedGames(nextPinnedGameIds: string[], activeGameId: string) {
    setSavingPinnedGameId(activeGameId);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          pinnedGameIds: nextPinnedGameIds,
        } satisfies Partial<HostConfig>),
      });

      if (!response.ok) {
        throw new Error(`Pinned game update failed: ${response.status}`);
      }

      setConfig((await response.json()) as HostConfig);
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setSavingPinnedGameId(null);
    }
  }

  async function togglePinnedGame(gameId: string) {
    const isPinned = config.pinnedGameIds.includes(gameId);
    const nextPinnedGameIds = isPinned
      ? config.pinnedGameIds.filter((pinnedGameId) => pinnedGameId !== gameId)
      : [...config.pinnedGameIds, gameId];

    await updatePinnedGames(nextPinnedGameIds, gameId);
  }

  async function movePinnedGame(gameId: string, direction: -1 | 1) {
    const currentIndex = config.pinnedGameIds.indexOf(gameId);

    if (currentIndex === -1) {
      return;
    }

    const nextIndex = currentIndex + direction;

    if (nextIndex < 0 || nextIndex >= config.pinnedGameIds.length) {
      return;
    }

    const nextPinnedGameIds = [...config.pinnedGameIds];
    const [movedGameId] = nextPinnedGameIds.splice(currentIndex, 1);

    if (!movedGameId) {
      return;
    }

    nextPinnedGameIds.splice(nextIndex, 0, movedGameId);

    await updatePinnedGames(nextPinnedGameIds, gameId);
  }

  async function clearMissingPinnedGames() {
    if (missingPinnedCount === 0) {
      return;
    }

    const nextPinnedGameIds = pinnedEntries
      .filter((entry) => !entry.missing)
      .map((entry) => entry.gameId);

    await updatePinnedGames(nextPinnedGameIds, bulkPinnedActionId);
  }

  function updateSimulationProfile(
    gameId: string,
    update: (profile: SimulationGameProfile) => SimulationGameProfile,
  ) {
    setSimulationCatalog((current) => ({
      games: current.games.map((profile) =>
        profile.gameId === gameId ? update(profile) : profile,
      ),
    }));
  }

  async function saveSimulationProfile(profile: SimulationGameProfile) {
    setSavingSimulationGameId(profile.gameId);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/simulation", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(profile),
      });

      if (!response.ok) {
        throw new Error(`Simulation update failed: ${response.status}`);
      }

      const nextCatalog = (await response.json()) as SimulationCatalog;
      setSimulationCatalog(nextCatalog);
      return nextCatalog;
    } catch (error) {
      setErrorMessage((error as Error).message);
      return null;
    } finally {
      setSavingSimulationGameId(null);
    }
  }

  async function probeStreamHost(profile: SimulationGameProfile) {
    setProbingSimulationGameId(profile.gameId);
    setErrorMessage(null);
    setStreamProbeResetMessagesByGameId((current) => {
      const next = { ...current };
      delete next[profile.gameId];
      return next;
    });

    try {
      const result = await postJson<StreamProbeResult>("/api/runtime/probe-stream-host", {
        processNames: profile.streamProbeProcessNames,
        ports: profile.streamProbePorts,
        timeoutMs: Math.max(profile.streamReadyDelayMs, 1200),
      });

      setStreamProbeResultsByGameId((current) => ({
        ...current,
        [profile.gameId]: result,
      }));
    } catch (error) {
      setErrorMessage((error as Error).message);
    } finally {
      setProbingSimulationGameId(null);
    }
  }

  async function applyStreamProbeResult(
    profile: SimulationGameProfile,
    result: StreamProbeResult,
  ) {
    const nextProfile: SimulationGameProfile = { ...profile };

    if (result.processName) {
      nextProfile.streamProbeProcessNames = mergeStringTarget(
        profile.streamProbeProcessNames,
        result.processName,
      );
    }

    if (result.listeningPorts.length > 0) {
      nextProfile.streamProbePorts = mergePortTargets(
        profile.streamProbePorts,
        result.listeningPorts,
      );
    }

    updateSimulationProfile(profile.gameId, () => nextProfile);
    setStreamProbeResetMessagesByGameId((current) => {
      const next = { ...current };
      delete next[profile.gameId];
      return next;
    });
    await saveSimulationProfile(nextProfile);
  }

  async function resetStreamProbeTargets(profile: SimulationGameProfile) {
    const nextProfile: SimulationGameProfile = {
      ...profile,
      streamProbeProcessNames: [],
      streamProbePorts: [],
    };

    updateSimulationProfile(profile.gameId, () => nextProfile);
    setStreamProbeResultsByGameId((current) => {
      const next = { ...current };
      delete next[profile.gameId];
      return next;
    });
    const savedCatalog = await saveSimulationProfile(nextProfile);
    const savedProfile = savedCatalog?.games.find((game) => game.gameId === profile.gameId);

    if (savedProfile) {
      setStreamProbeResetMessagesByGameId((current) => ({
        ...current,
        [profile.gameId]: describeStreamProbeTargets(savedProfile),
      }));
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
                  (!diagnostics.guestAgentReachable || Boolean(diagnostics.eventStreamConnected))) ||
                (recoveryState.action === "attach-display" &&
                  (!diagnostics.remotePlayReady || Boolean(diagnostics.remoteClientAttached)))
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

      <section className="browse-stage panel">
        <div className="panel-header browse-stage-header">
          <div>
            <p className="panel-kicker">Browse</p>
            <h2>Game Browser</h2>
          </div>
          <span className="badge">
            {filteredGames.length} visible
          </span>
        </div>
        <div className="toolbar browse-stage-toolbar">
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
        <div className="catalog-overview browse-stage-overview">
          <span className="chip">
            Real Steam {catalogInsights.realSteamCount}
          </span>
          <span className="chip">
            Real Ubisoft {catalogInsights.realUbisoftCount}
          </span>
          <span className="chip">
            Pinned {config.pinnedGameIds.length}
          </span>
          {catalogInsights.unknownCount > 0 ? (
            <span className="chip">
              Unknown {catalogInsights.unknownCount}
            </span>
          ) : null}
        </div>
        {selectedGame ? (
          <div className="browse-spotlight">
            <GameArtwork className="spotlight-art" game={selectedGame} variant="hero" />
            <div className="spotlight-content">
              <div className="chip-row spotlight-chips">
                <span className="chip">{launcherLabel(selectedGame.launcher)}</span>
                <span className="chip">{installStateLabel(selectedGame.installState)}</span>
                <span className="chip">
                  {discoverySourceLabel(selectedGame.guestMetadata.discoverySource)}
                </span>
              </div>
              <h2 className="spotlight-title">{selectedGame.title}</h2>
              <p className="spotlight-description">{gameDescription(selectedGame)}</p>
              <p
                className={`spotlight-status ${
                  selectedLaunchCheck?.canLaunch ? "spotlight-status-ready" : "spotlight-status-blocked"
                }`}
              >
                {gameStatusSummary(
                  selectedGame,
                  Boolean(selectedLaunchCheck?.canLaunch),
                  selectedLaunchCheck?.reason,
                )}
              </p>
              <div className="spotlight-meta">
                <div>
                  <span>Launch path</span>
                  <strong>{launchStrategyLabel(selectedGame.guestMetadata.launchStrategy)}</strong>
                </div>
                <div>
                  <span>Last seen</span>
                  <strong>{formatTime(selectedGame.lastSeenAt)}</strong>
                </div>
                <div>
                  <span>Launch mode</span>
                  <strong>{selectedGame.guestMetadata.lastLaunchMode ?? "n/a"}</strong>
                </div>
                <div>
                  <span>Observed process</span>
                  <strong>{selectedGame.guestMetadata.lastObservedProcessName ?? "n/a"}</strong>
                </div>
              </div>
              <div className="spotlight-actions">
                <button
                  disabled={filteredGames.length < 2}
                  onClick={() => moveSelectedGame(-1)}
                >
                  Previous
                </button>
                <button
                  disabled={filteredGames.length < 2}
                  onClick={() => moveSelectedGame(1)}
                >
                  Next
                </button>
                <button
                  disabled={busyAction !== null || savingPinnedGameId === selectedGame.id}
                  onClick={() => void togglePinnedGame(selectedGame.id)}
                >
                  {config.pinnedGameIds.includes(selectedGame.id) ? "Unpin" : "Pin"}
                </button>
                <button
                  disabled={busyAction !== null || !selectedLaunchCheck?.canLaunch}
                  onClick={() => void launchGame(selectedGame.id)}
                >
                  Launch
                </button>
              </div>
            </div>
          </div>
        ) : (
          <p className="empty-state browse-empty-state">No games match the current filter.</p>
        )}
        <div className="browse-strip" role="list" aria-label="Game browser">
          {filteredGames.map((game) => {
            const launchCheck =
              launchChecksByGameId.get(game.id) ?? canLaunchGame(game, snapshot.status);

            return (
              <button
                key={game.id}
                className={`browse-card ${selectedGame?.id === game.id ? "browse-card-selected" : ""}`}
                onClick={() => setSelectedGameId(game.id)}
                type="button"
              >
                <GameArtwork className="browse-card-art" game={game} variant="poster" />
                <div className="browse-card-body">
                  <div>
                    <p className="browse-card-title">{game.title}</p>
                    <p className="browse-card-subtitle">
                      {launcherLabel(game.launcher)} · {discoverySourceLabel(game.guestMetadata.discoverySource)}
                    </p>
                  </div>
                  <span className={`browse-card-state ${launchCheck.canLaunch ? "launch-ready" : "launch-blocked"}`}>
                    {launchCheck.canLaunch ? "Ready" : "Blocked"}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

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
            <button
              disabled={
                busyAction !== null ||
                !diagnostics.remotePlayReady ||
                Boolean(diagnostics.remoteClientAttached)
              }
              onClick={() => void runAction("attach-display")}
            >
              Attach display
            </button>
            <button
              disabled={busyAction !== null || !diagnostics.remoteClientAttached}
              onClick={() => void runAction("detach-display")}
            >
              Detach display
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
          <div className="source-summary">
            <div className="source-card">
              <span>Steam discovered</span>
              <strong>
                {catalogInsights.realSteamCount > 0
                  ? `${catalogInsights.realSteamCount} real`
                  : "no real titles"}
              </strong>
              <small>{catalogInsights.steamLibraryCount} library roots</small>
            </div>
            <div className="source-card">
              <span>Steam fallback</span>
              <strong>{catalogInsights.sampleSteamCount}</strong>
              <small>sample entries</small>
            </div>
            <div className="source-card">
              <span>Ubisoft discovered</span>
              <strong>
                {catalogInsights.realUbisoftCount > 0
                  ? `${catalogInsights.realUbisoftCount} real`
                  : "no real titles"}
              </strong>
              <small>registry or manifest</small>
            </div>
            <div className="source-card">
              <span>Ubisoft fallback</span>
              <strong>{catalogInsights.sampleUbisoftCount}</strong>
              <small>sample entries</small>
            </div>
          </div>
          <div className="diagnostic-list">
            <div className="diagnostic-item">
              <span>Guest agent</span>
              <strong>{diagnostics.guestAgentReachable ? "reachable" : "offline"}</strong>
            </div>
            <div className="diagnostic-item">
              <span>Event stream</span>
              <strong>{eventStreamStateLabel(diagnostics)}</strong>
            </div>
            <div className="diagnostic-item">
              <span>Dashboard feed</span>
              <strong>{eventFeedMode === "websocket" ? "live websocket" : "HTTP polling"}</strong>
            </div>
            <div className="diagnostic-item">
              <span>Remote play</span>
              <strong>{diagnostics.remotePlayReady ? "ready" : "waiting"}</strong>
            </div>
            <div className="diagnostic-item">
              <span>Readiness stall</span>
              <strong>{diagnostics.remotePlayStalled ? "stalled" : "clear"}</strong>
            </div>
            <div className="diagnostic-item">
              <span>Remote client</span>
              <strong>{diagnostics.remoteClientAttached ? "attached" : "not attached"}</strong>
            </div>
            <div className="diagnostic-item">
              <span>Active session</span>
              <strong>{diagnostics.activeSessionRunning ? diagnosticsSessionTitle : "none"}</strong>
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
                onChange={(event) => {
                  setConfigSaveMessage(null);
                  setConfig((current) => ({
                    ...current,
                    runtimeProvider: event.target.value as RuntimeProviderId,
                  }));
                }}
              >
                <option value="fake">fake</option>
                <option value="managed-vm">managed-vm</option>
              </select>
            </label>
            <label>
              VM name
              <input
                value={config.managedVm.vmName}
                onChange={(event) => {
                  setConfigSaveMessage(null);
                  setConfig((current) => ({
                    ...current,
                    managedVm: {
                      ...current.managedVm,
                      vmName: event.target.value,
                    },
                  }));
                }}
              />
            </label>
            <label>
              Guest agent URL
              <input
                value={config.managedVm.guestAgentBaseUrl}
                onChange={(event) => {
                  setConfigSaveMessage(null);
                  setConfig((current) => ({
                    ...current,
                    managedVm: {
                      ...current.managedVm,
                      guestAgentBaseUrl: event.target.value,
                    },
                  }));
                }}
              />
            </label>
            <button disabled={savingConfig || busyAction !== null} type="submit">
              Save config
            </button>
          </form>
          {configSaveMessage ? <p className="config-save-message">{configSaveMessage}</p> : null}
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
              <h2>Game Details</h2>
            </div>
          </div>
          {pinnedEntries.length > 0 ? (
            <div className="pinned-games">
              <div className="pinned-games-header">
                <div className="session-history-header">
                  <span>Pinned games</span>
                  <strong>
                    {pinnedEntries.length}
                    {missingPinnedCount > 0 ? ` · ${missingPinnedCount} missing` : ""}
                  </strong>
                </div>
                {missingPinnedCount > 0 ? (
                  <button
                    disabled={busyAction !== null || savingPinnedGameId === bulkPinnedActionId}
                    onClick={() => void clearMissingPinnedGames()}
                  >
                    Clear missing pins
                  </button>
                ) : null}
              </div>
              <div className="pinned-games-grid">
                {pinnedEntries.map((entry, index) => {
                  if (!entry.game) {
                    return (
                      <div
                        key={`pinned-${entry.gameId}`}
                        className="pinned-game-card pinned-game-missing"
                      >
                        <div>
                          <p className="game-title">{entry.gameId}</p>
                          <p className="game-subtitle">Pinned game missing from current catalog scan</p>
                          <p className="game-meta-line">
                            Run a fresh scan or verify the guest launcher/library before removing
                            this pin.
                          </p>
                        </div>
                        <div className="session-history-actions pin-card-actions">
                          <span className="chip">missing</span>
                          <div className="pin-order-actions">
                            <button
                              disabled={busyAction !== null || savingPinnedGameId === entry.gameId || index === 0}
                              onClick={(event) => {
                                event.stopPropagation();
                                void movePinnedGame(entry.gameId, -1);
                              }}
                            >
                              Up
                            </button>
                            <button
                              disabled={
                                busyAction !== null ||
                                savingPinnedGameId === entry.gameId ||
                                index === pinnedEntries.length - 1
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                void movePinnedGame(entry.gameId, 1);
                              }}
                            >
                              Down
                            </button>
                          </div>
                          <button
                            disabled={busyAction !== null || savingPinnedGameId === entry.gameId}
                            onClick={(event) => {
                              event.stopPropagation();
                              void togglePinnedGame(entry.gameId);
                            }}
                          >
                            Unpin
                          </button>
                        </div>
                      </div>
                    );
                  }

                  const game = entry.game;

                  return (
                    <div
                      key={`pinned-${game.id}`}
                      className={`pinned-game-card ${
                        selectedGame?.id === game.id ? "game-card-selected" : ""
                      }`}
                      onClick={() => setSelectedGameId(game.id)}
                    >
                      <div>
                        <p className="game-title">{game.title}</p>
                        <p className="game-subtitle">
                          {entry.launchCheck?.canLaunch ? "Ready to launch" : entry.launchCheck?.reason}
                        </p>
                      </div>
                      <div className="session-history-actions pin-card-actions">
                        <div className="pin-order-actions">
                          <button
                            disabled={busyAction !== null || savingPinnedGameId === game.id || index === 0}
                            onClick={(event) => {
                              event.stopPropagation();
                              void movePinnedGame(game.id, -1);
                            }}
                          >
                            Up
                          </button>
                          <button
                            disabled={
                              busyAction !== null ||
                              savingPinnedGameId === game.id ||
                              index === pinnedEntries.length - 1
                            }
                            onClick={(event) => {
                              event.stopPropagation();
                              void movePinnedGame(game.id, 1);
                            }}
                          >
                            Down
                          </button>
                        </div>
                        <button
                          disabled={busyAction !== null || savingPinnedGameId === game.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            void togglePinnedGame(game.id);
                          }}
                        >
                          Unpin
                        </button>
                        <button
                          disabled={busyAction !== null || !entry.launchCheck?.canLaunch}
                          onClick={(event) => {
                            event.stopPropagation();
                            void launchGame(game.id);
                          }}
                        >
                          Quick launch
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          {!selectedGame && filteredGames.length === 0 ? (
            <p className="empty-state">Run a scan or change the filter to browse games.</p>
          ) : null}
          {selectedGame ? (
            <div className="selected-game-card">
              <div className="panel-header">
                <div>
                  <p className="panel-kicker">Selected Game</p>
                  <h3>{selectedGame.title}</h3>
                </div>
                <span
                  className={`badge ${
                    selectedLaunchCheck?.canLaunch ? "launch-ready" : "launch-blocked"
                  }`}
                >
                  {selectedLaunchCheck?.canLaunch ? "Launch ready" : "Launch blocked"}
                </span>
              </div>
              <p className="game-subtitle">
                {selectedGame.launcher} · {selectedGame.installState} ·{" "}
                {discoverySourceLabel(selectedGame.guestMetadata.discoverySource)}
              </p>
              <p className="game-meta-line">
                Strategy {launchStrategyLabel(selectedGame.guestMetadata.launchStrategy)}
              </p>
              {selectedGame.guestMetadata.installRoot ? (
                <p className="game-path">{selectedGame.guestMetadata.installRoot}</p>
              ) : null}
              {selectedLaunchCheck && !selectedLaunchCheck.canLaunch ? (
                <p className="selected-game-warning">{selectedLaunchCheck.reason}</p>
              ) : (
                <p className="selected-game-ready">
                  Guest runtime conditions currently allow this launch.
                </p>
              )}
              <div className="selected-game-grid">
                <div>
                  <span>Last launch detail</span>
                  <strong>{selectedGame.guestMetadata.lastLaunchDetail ?? "n/a"}</strong>
                </div>
                <div>
                  <span>Observed process</span>
                  <strong>{selectedGame.guestMetadata.lastObservedProcessName ?? "n/a"}</strong>
                </div>
                <div>
                  <span>Launch mode</span>
                  <strong>{selectedGame.guestMetadata.lastLaunchMode ?? "n/a"}</strong>
                </div>
                <div>
                  <span>Stream ready mode</span>
                  <strong>{selectedGame.guestMetadata.lastStreamReadyMode ?? "n/a"}</strong>
                </div>
                <div>
                  <span>Stream ready detail</span>
                  <strong>{selectedGame.guestMetadata.lastStreamReadyDetail ?? "n/a"}</strong>
                </div>
                <div>
                  <span>Stream host ports</span>
                  <strong>{selectedGame.guestMetadata.lastStreamHostPorts ?? "n/a"}</strong>
                </div>
                <div>
                  <span>Configured probe processes</span>
                  <strong>
                    {formatList(selectedSimulationProfile?.streamProbeProcessNames) ||
                      formatMetadataList(selectedGame.guestMetadata.streamProbeProcessNames) ||
                      "n/a"}
                  </strong>
                </div>
                <div>
                  <span>Configured probe ports</span>
                  <strong>
                    {formatList(selectedSimulationProfile?.streamProbePorts) ||
                      formatMetadataList(selectedGame.guestMetadata.streamProbePorts) ||
                      "n/a"}
                  </strong>
                </div>
                <div>
                  <span>Last seen</span>
                  <strong>{formatTime(selectedGame.lastSeenAt)}</strong>
                </div>
              </div>
              {selectedStreamProbeResult ? (
                <StreamProbeResultPanel
                  result={selectedStreamProbeResult}
                  targetsConfigured={
                    selectedSimulationProfile
                      ? selectedStreamProbeTargetsConfigured
                      : undefined
                  }
                />
              ) : null}
              {selectedStreamProbeResetMessage ? (
                <p className="stream-probe-target-state">
                  {selectedStreamProbeResetMessage}
                </p>
              ) : null}
              <div className="chip-row">
                {selectedGame.compatibilityFlags.map((flag) => (
                  <span key={flag} className="chip">
                    {flag}
                  </span>
                ))}
                {selectedGame.guestMetadata.steamLibraryRoot ? (
                  <span className="chip">library {selectedGame.guestMetadata.steamLibraryRoot}</span>
                ) : null}
              </div>
              <div className="selected-game-actions">
                <button
                  disabled={busyAction !== null || savingPinnedGameId === selectedGame.id}
                  onClick={() => void togglePinnedGame(selectedGame.id)}
                >
                  {config.pinnedGameIds.includes(selectedGame.id) ? "Unpin selected" : "Pin selected"}
                </button>
                {selectedSimulationProfile ? (
                  <button
                    disabled={
                      busyAction !== null ||
                      probingSimulationGameId === selectedSimulationProfile.gameId ||
                      !diagnostics.guestAgentReachable
                    }
                    onClick={() => void probeStreamHost(selectedSimulationProfile)}
                  >
                    {probingSimulationGameId === selectedSimulationProfile.gameId
                      ? "Testing..."
                      : "Test selected Sunshine"}
                  </button>
                ) : null}
                {selectedSimulationProfile && selectedStreamProbeResult?.ok ? (
                  <button
                    disabled={
                      busyAction !== null ||
                      savingSimulationGameId === selectedSimulationProfile.gameId ||
                      selectedStreamProbeTargetsConfigured ||
                      (!selectedStreamProbeResult.processName &&
                        selectedStreamProbeResult.listeningPorts.length === 0)
                    }
                    onClick={() =>
                      void applyStreamProbeResult(
                        selectedSimulationProfile,
                        selectedStreamProbeResult,
                      )
                    }
                  >
                    {selectedStreamProbeTargetsConfigured
                      ? "Targets already saved"
                      : "Add observed targets"}
                  </button>
                ) : null}
                {selectedSimulationProfile ? (
                  <button
                    disabled={
                      busyAction !== null ||
                      savingSimulationGameId === selectedSimulationProfile.gameId
                    }
                    onClick={() => void resetStreamProbeTargets(selectedSimulationProfile)}
                  >
                    Reset probe targets
                  </button>
                ) : null}
                <button
                  disabled={busyAction !== null || !selectedLaunchCheck?.canLaunch}
                  onClick={() => void launchGame(selectedGame.id)}
                >
                  Launch selected
                </button>
              </div>
            </div>
          ) : null}
        </article>

        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Session</p>
              <h2>Launch Timeline</h2>
            </div>
            <div className="session-history-actions">
              {diagnostics.remotePlayStalled ? (
                <button
                  disabled={busyAction !== null}
                  onClick={() => void runAction("recover-session")}
                >
                  Restart launch
                </button>
              ) : null}
              {activeSession ? (
                <button
                  disabled={busyAction !== null}
                  onClick={() => void terminateSession(activeSession.id)}
                >
                  Terminate
                </button>
              ) : null}
            </div>
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
            <span>Remote client {diagnostics.remoteClientAttached ? "attached" : "waiting"}</span>
            <span>
              Session age {formatDurationMs(diagnostics.activeSessionAgeMs)}
            </span>
            <span>
              Expected ready {formatDurationMs(diagnostics.activeSessionExpectedReadyMs)}
            </span>
            <span>
              Stall state {diagnostics.remotePlayStalled ? "stalled" : "clear"}
            </span>
            <span>
              Launch path{" "}
              {launchContextGame
                ? launchStrategyLabel(launchContextGame.guestMetadata.launchStrategy)
                : "n/a"}
            </span>
            <span>
              Launch detail {launchContextGame?.guestMetadata.lastLaunchDetail ?? "n/a"}
            </span>
            <span>
              Display handoff {diagnostics.lastDisplayAttachDetail ?? "n/a"}
            </span>
          </div>
          <div className="session-history">
            <div className="session-history-header">
              <span>Recent sessions</span>
              <strong>{snapshot.sessions.length}</strong>
            </div>
            {recentSessions.map((session) => {
              const sessionGame = gamesById.get(session.gameId);
              const sessionTitle = sessionGame?.title ?? session.gameId;
              const canRelaunch =
                busyAction === null &&
                !activeSession &&
                snapshot.status.guestPowerState === "running" &&
                snapshot.status.agentState === "ready" &&
                sessionGame?.installState === "installed";

              return (
                <div key={session.id} className={`session-history-card tone-${sessionTone(session)}`}>
                  <div>
                    <p className="game-title">{sessionTitle}</p>
                    <p className="game-subtitle">
                      {sessionStateLabel(session)} · stream {session.streamState}
                    </p>
                    <p className="game-meta-line">
                      Started {formatTime(session.startedAt)}
                      {session.endedAt ? ` · ended ${formatTime(session.endedAt)}` : ""}
                    </p>
                    {session.lastError ? (
                      <p className="session-error-line">{session.lastError}</p>
                    ) : null}
                  </div>
                  <div className="session-history-actions">
                    <span className="chip">{session.runtimeState}</span>
                    <button
                      disabled={!canRelaunch}
                      onClick={() => void launchGame(session.gameId)}
                    >
                      Relaunch
                    </button>
                  </div>
                </div>
              );
            })}
            {recentSessions.length === 0 ? (
              <p className="empty-state">No recent sessions yet.</p>
            ) : null}
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

      {config.runtimeProvider === "managed-vm" ? (
        <section className="simulation-section">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Guest Simulation</p>
                <h2>Launch Scenario Controls</h2>
              </div>
              <span className="badge">
                {diagnostics.guestAgentReachable ? "Guest reachable" : "Guest offline"}
              </span>
            </div>
            <p className="simulation-intro">
              Drive healthy, failed, and slow-stream managed-VM launch paths from the host UI
              without editing the guest scaffold directly.
            </p>
            {!diagnostics.guestAgentReachable ? (
              <p className="empty-state">
                Start the managed guest before editing guest-side simulation profiles.
              </p>
            ) : (
              <div className="simulation-list">
                {simulationCatalog.games.map((profile) => {
                  const streamProbeResult = streamProbeResultsByGameId[profile.gameId];
                  const streamProbeResetMessage =
                    streamProbeResetMessagesByGameId[profile.gameId];
                  const streamProbeTargetsConfigured = streamProbeResult
                    ? streamProbeTargetsAlreadyConfigured(profile, streamProbeResult)
                    : false;

                  return (
                    <div key={profile.gameId} className="simulation-card">
                    <div className="simulation-card-header">
                      <div>
                        <p className="game-title">
                          {gameTitlesById.get(profile.gameId) ?? profile.gameId}
                        </p>
                        <p className="game-subtitle">{profile.gameId}</p>
                      </div>
                      <span className="chip">{profile.outcome}</span>
                    </div>
                    <div className="simulation-grid">
                      <label>
                        Outcome
                        <select
                          value={profile.outcome}
                          onChange={(event) =>
                            updateSimulationProfile(profile.gameId, (current) => ({
                              ...current,
                              outcome: event.target.value as SimulationOutcome,
                            }))
                          }
                        >
                          <option value="success">success</option>
                          <option value="fail-before-stream-ready">
                            fail-before-stream-ready
                          </option>
                        </select>
                      </label>
                      <label>
                        Launch accept delay
                        <input
                          min={0}
                          type="number"
                          value={profile.launchAcceptedDelayMs}
                          onChange={(event) =>
                            updateSimulationProfile(profile.gameId, (current) => ({
                              ...current,
                              launchAcceptedDelayMs: Number(event.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Game detect delay
                        <input
                          min={0}
                          type="number"
                          value={profile.gameDetectedDelayMs}
                          onChange={(event) =>
                            updateSimulationProfile(profile.gameId, (current) => ({
                              ...current,
                              gameDetectedDelayMs: Number(event.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Stream ready delay
                        <input
                          min={0}
                          type="number"
                          value={profile.streamReadyDelayMs}
                          onChange={(event) =>
                            updateSimulationProfile(profile.gameId, (current) => ({
                              ...current,
                              streamReadyDelayMs: Number(event.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Sunshine processes
                        <input
                          key={`${profile.gameId}-processes-${formatList(profile.streamProbeProcessNames)}`}
                          defaultValue={formatList(profile.streamProbeProcessNames)}
                          onBlur={(event) =>
                            updateSimulationProfile(profile.gameId, (current) => ({
                              ...current,
                              streamProbeProcessNames: parseStringList(event.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Sunshine ports
                        <input
                          key={`${profile.gameId}-ports-${formatList(profile.streamProbePorts)}`}
                          defaultValue={formatList(profile.streamProbePorts)}
                          onBlur={(event) =>
                            updateSimulationProfile(profile.gameId, (current) => ({
                              ...current,
                              streamProbePorts: parsePortList(event.target.value),
                            }))
                          }
                        />
                      </label>
                    </div>
                    {streamProbeResult ? (
                      <StreamProbeResultPanel
                        result={streamProbeResult}
                        targetsConfigured={streamProbeTargetsConfigured}
                      />
                    ) : null}
                    {streamProbeResetMessage ? (
                      <p className="stream-probe-target-state">
                        {streamProbeResetMessage}
                      </p>
                    ) : null}
                    <label className="simulation-message">
                      Failure message
                      <input
                        value={profile.failureMessage}
                        onChange={(event) =>
                          updateSimulationProfile(profile.gameId, (current) => ({
                            ...current,
                            failureMessage: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <div className="simulation-actions">
                      <button
                        disabled={busyAction !== null || savingSimulationGameId === profile.gameId}
                        onClick={() => void saveSimulationProfile(profile)}
                      >
                        {savingSimulationGameId === profile.gameId ? "Saving..." : "Save scenario"}
                      </button>
                      <button
                        disabled={
                          busyAction !== null ||
                          probingSimulationGameId === profile.gameId ||
                          !diagnostics.guestAgentReachable
                        }
                        onClick={() => void probeStreamHost(profile)}
                      >
                        {probingSimulationGameId === profile.gameId ? "Testing..." : "Test Sunshine"}
                      </button>
                      {streamProbeResult?.ok ? (
                        <button
                          disabled={
                            busyAction !== null ||
                            savingSimulationGameId === profile.gameId ||
                            streamProbeTargetsConfigured ||
                            (!streamProbeResult.processName &&
                              streamProbeResult.listeningPorts.length === 0)
                          }
                          onClick={() => void applyStreamProbeResult(profile, streamProbeResult)}
                        >
                          {streamProbeTargetsConfigured
                            ? "Targets already saved"
                            : "Add observed targets"}
                        </button>
                      ) : null}
                      <button
                        disabled={busyAction !== null || savingSimulationGameId === profile.gameId}
                        onClick={() => void resetStreamProbeTargets(profile)}
                      >
                        Reset probe targets
                      </button>
                    </div>
                  </div>
                  );
                })}
                {simulationCatalog.games.length === 0 ? (
                  <p className="empty-state">
                    No guest simulation profiles are available yet. Verify the guest scaffold is
                    reachable.
                  </p>
                ) : null}
              </div>
            )}
          </article>
        </section>
      ) : null}
    </main>
  );
}
