import type {
  GameRecord,
  GameSession,
  GuestStatusSnapshot,
  SessionRuntimeState,
} from "@game-vm-hub/shared-types";

const sessionStatePriority: Record<SessionRuntimeState, number> = {
  queued: 0,
  launching: 1,
  running: 2,
  ended: 3,
  failed: 4,
  terminated: 5,
};

export function mergeGameRecords(sources: GameRecord[][]): GameRecord[] {
  const merged = new Map<string, GameRecord>();

  for (const source of sources) {
    for (const game of source) {
      const existing = merged.get(game.id);

      if (!existing) {
        merged.set(game.id, {
          ...game,
          compatibilityFlags: [...game.compatibilityFlags],
          guestMetadata: { ...game.guestMetadata },
        });
        continue;
      }

      const preferred =
        Date.parse(game.lastSeenAt) >= Date.parse(existing.lastSeenAt) ? game : existing;

      merged.set(game.id, {
        ...preferred,
        compatibilityFlags: [
          ...new Set([...existing.compatibilityFlags, ...game.compatibilityFlags]),
        ],
        guestMetadata: {
          ...existing.guestMetadata,
          ...game.guestMetadata,
        },
      });
    }
  }

  return [...merged.values()].sort((left, right) =>
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }),
  );
}

export function canLaunchGame(
  game: GameRecord,
  status: GuestStatusSnapshot,
): { canLaunch: boolean; reason?: string } {
  if (game.installState !== "installed") {
    return { canLaunch: false, reason: "Game is not installed in the guest." };
  }

  if (status.guestPowerState !== "running") {
    return { canLaunch: false, reason: "Windows guest is not running." };
  }

  if (status.agentState !== "ready") {
    return { canLaunch: false, reason: "Windows guest agent is not ready." };
  }

  if (status.activeSessionId) {
    return { canLaunch: false, reason: "Another session is already active." };
  }

  return { canLaunch: true };
}

export function sortSessionsByRecency(sessions: GameSession[]): GameSession[] {
  return [...sessions].sort((left, right) => {
    const startedDelta = Date.parse(right.startedAt) - Date.parse(left.startedAt);

    if (startedDelta !== 0) {
      return startedDelta;
    }

    return sessionStatePriority[right.runtimeState] - sessionStatePriority[left.runtimeState];
  });
}

export function findGameById(games: GameRecord[], gameId: string): GameRecord | undefined {
  return games.find((game) => game.id === gameId);
}

