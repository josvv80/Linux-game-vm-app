import { describe, expect, it } from "vitest";
import type { GameRecord, GuestStatusSnapshot } from "@game-vm-hub/shared-types";
import { canLaunchGame, mergeGameRecords } from "./index.js";

function createGame(overrides: Partial<GameRecord> = {}): GameRecord {
  return {
    id: "steam:1",
    title: "Alpha",
    launcher: "steam",
    installState: "installed",
    launchCommandRef: "steam://run/1",
    lastSeenAt: "2026-06-06T10:00:00.000Z",
    compatibilityFlags: ["prototype"],
    guestMetadata: {},
    ...overrides,
  };
}

function createStatus(overrides: Partial<GuestStatusSnapshot> = {}): GuestStatusSnapshot {
  return {
    guestPowerState: "running",
    agentState: "ready",
    streamHostState: "ready",
    scanState: "complete",
    warnings: [],
    ...overrides,
  };
}

describe("mergeGameRecords", () => {
  it("merges by id and preserves the newest timestamp", () => {
    const merged = mergeGameRecords([
      [
        createGame({
          compatibilityFlags: ["prototype"],
          guestMetadata: { source: "old" },
        }),
      ],
      [
        createGame({
          title: "Alpha Prime",
          lastSeenAt: "2026-06-06T11:00:00.000Z",
          compatibilityFlags: ["single-gpu-vfio-risk"],
          guestMetadata: { source: "new" },
        }),
      ],
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("Alpha Prime");
    expect(merged[0]?.compatibilityFlags).toEqual([
      "prototype",
      "single-gpu-vfio-risk",
    ]);
    expect(merged[0]?.guestMetadata.source).toBe("new");
  });
});

describe("canLaunchGame", () => {
  it("rejects launch when another session is active", () => {
    const result = canLaunchGame(createGame(), createStatus({ activeSessionId: "session-1" }));

    expect(result).toEqual({
      canLaunch: false,
      reason: "Another session is already active.",
    });
  });

  it("allows launch for installed games on a ready guest", () => {
    expect(canLaunchGame(createGame(), createStatus())).toEqual({ canLaunch: true });
  });
});

