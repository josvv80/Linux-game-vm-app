import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostConfig, HostConfigPatch } from "@game-vm-hub/shared-types";

export const defaultHostConfig: HostConfig = {
  runtimeProvider: "fake",
  managedVm: {
    vmName: "win11-gaming",
    guestAgentBaseUrl: "http://127.0.0.1:8765",
    streamMode: "sunshine-moonlight",
  },
};

function mergeConfig(base: HostConfig, patch: HostConfigPatch): HostConfig {
  return {
    runtimeProvider: patch.runtimeProvider ?? base.runtimeProvider,
    managedVm: {
      ...base.managedVm,
      ...patch.managedVm,
    },
  };
}

export class ConfigStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<HostConfig> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return mergeConfig(defaultHostConfig, JSON.parse(raw) as HostConfigPatch);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return structuredClone(defaultHostConfig);
      }

      throw error;
    }
  }

  async write(patch: HostConfigPatch): Promise<HostConfig> {
    const current = await this.read();
    const next = mergeConfig(current, patch);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return next;
  }
}
