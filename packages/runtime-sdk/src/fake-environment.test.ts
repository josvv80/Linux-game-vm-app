import { describe, expect, it } from "vitest";
import { createFakeEnvironment } from "./fake-environment.js";

describe("FakeEnvironment", () => {
  it("starts, scans, and launches a session", async () => {
    const environment = createFakeEnvironment({ stepDelayMs: 1 });

    await environment.runtimeProvider.startGuest();
    const games = await environment.guestConnection.scanGames();
    const result = await environment.guestConnection.launchGame(games[0]!.id);
    const snapshot = environment.snapshot();

    expect(result.session.runtimeState).toBe("running");
    expect(snapshot.status.activeSessionId).toBe(result.session.id);
    expect(snapshot.events[0]?.type).toBe("session.streaming.ready");
  });

  it("terminates the active session", async () => {
    const environment = createFakeEnvironment({ stepDelayMs: 1 });

    await environment.runtimeProvider.startGuest();
    const games = await environment.guestConnection.scanGames();
    const result = await environment.guestConnection.launchGame(games[0]!.id);
    const terminated = await environment.guestConnection.terminateSession(result.session.id);

    expect(terminated?.runtimeState).toBe("terminated");
    expect(environment.snapshot().status.activeSessionId).toBeUndefined();
  });
});
