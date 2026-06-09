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

  it("tracks remote display attachment after the stream becomes ready", async () => {
    const environment = createFakeEnvironment({ stepDelayMs: 1 });

    await environment.runtimeProvider.startGuest();
    const games = await environment.guestConnection.scanGames();
    await environment.guestConnection.launchGame(games[0]!.id);

    const attachResult = await environment.runtimeProvider.attachDisplay();
    const diagnostics = await environment.runtimeProvider.getDiagnostics();

    expect(attachResult).toMatchObject({
      ok: true,
      detail: "Moonlight would attach here in the real runtime provider.",
    });
    expect(diagnostics).toMatchObject({
      remotePlayReady: true,
      remoteClientAttached: true,
      activeSessionRunning: true,
      activeSessionStreamReady: true,
      lastDisplayAttachDetail: "Moonlight would attach here in the real runtime provider.",
    });
    expect(environment.snapshot().events[0]?.type).toBe("display.attached");
  });

  it("lets the operator detach a remote client without stopping the session", async () => {
    const environment = createFakeEnvironment({ stepDelayMs: 1 });

    await environment.runtimeProvider.startGuest();
    const games = await environment.guestConnection.scanGames();
    const launch = await environment.guestConnection.launchGame(games[0]!.id);
    await environment.runtimeProvider.attachDisplay();

    const detachResult = await environment.runtimeProvider.detachDisplay();
    const diagnostics = await environment.runtimeProvider.getDiagnostics();
    const snapshot = environment.snapshot();

    expect(detachResult).toMatchObject({
      ok: true,
      detail: "Remote client detached. The stream path stays ready for another attachment.",
    });
    expect(diagnostics).toMatchObject({
      remotePlayReady: true,
      remoteClientAttached: false,
      activeSessionRunning: true,
      activeSessionStreamReady: true,
      lastDisplayAttachDetail:
        "Remote client detached. The stream path stays ready for another attachment.",
    });
    expect(snapshot.status.activeSessionId).toBe(launch.session.id);
    expect(snapshot.events[0]?.type).toBe("display.detached");
  });
});
