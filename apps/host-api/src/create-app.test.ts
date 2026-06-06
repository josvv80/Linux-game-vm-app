import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./create-app.js";
import { AppState } from "./state.js";
import { ConfigStore, defaultHostConfig } from "./config-store.js";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const apps: Array<ReturnType<typeof buildApp>> = [];

afterEach(async () => {
  while (apps.length > 0) {
    await apps.pop()?.close();
  }
});

describe("host API", () => {
  it("boots the fake guest and returns status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    await mkdir(dir, { recursive: true });
    const app = buildApp(
      new AppState(new ConfigStore(join(dir, "host-config.json")), defaultHostConfig),
    );
    apps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().guestPowerState).toBe("running");
  });

  it("scans the catalog after the guest is running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const app = buildApp(
      new AppState(new ConfigStore(join(dir, "host-config.json")), defaultHostConfig),
    );
    apps.push(app);

    await app.inject({
      method: "POST",
      url: "/api/runtime/start",
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/catalog/scan",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
  });

  it("persists provider config changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "game-vm-hub-test-"));
    const configPath = join(dir, "host-config.json");
    const app = buildApp(new AppState(new ConfigStore(configPath), defaultHostConfig));
    apps.push(app);

    const response = await app.inject({
      method: "PUT",
      url: "/api/config",
      payload: {
        runtimeProvider: "managed-vm",
        managedVm: {
          vmName: "windows-vfio",
          guestAgentBaseUrl: "http://192.168.1.20:8765",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().runtimeProvider).toBe("managed-vm");

    const raw = await readFile(configPath, "utf8");
    expect(JSON.parse(raw)).toMatchObject({
      runtimeProvider: "managed-vm",
      managedVm: {
        vmName: "windows-vfio",
        guestAgentBaseUrl: "http://192.168.1.20:8765",
      },
    });
  });
});
