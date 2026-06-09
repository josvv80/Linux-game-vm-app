import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostConfig, HostConfigPatch, RuntimeProviderId } from "@game-vm-hub/shared-types";

export const defaultHostConfig: HostConfig = {
  runtimeProvider: "fake",
  managedVm: {
    vmName: "win11-gaming",
    guestAgentBaseUrl: "http://127.0.0.1:8765",
    streamMode: "sunshine-moonlight",
  },
  pinnedGameIds: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeRuntimeProvider(value: unknown): RuntimeProviderId | undefined {
  return value === "fake" || value === "managed-vm" ? value : undefined;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePinnedGameIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<string>();
  const pinnedGameIds: string[] = [];

  for (const item of value) {
    const gameId = normalizeText(item);

    if (gameId && !seen.has(gameId)) {
      pinnedGameIds.push(gameId);
      seen.add(gameId);
    }
  }

  return pinnedGameIds;
}

export function normalizeHostConfigPatch(rawPatch: unknown): HostConfigPatch {
  if (!isRecord(rawPatch)) {
    return {};
  }

  const patch: HostConfigPatch = {};
  const runtimeProvider = normalizeRuntimeProvider(rawPatch.runtimeProvider);

  if (runtimeProvider) {
    patch.runtimeProvider = runtimeProvider;
  }

  if (isRecord(rawPatch.managedVm)) {
    const vmName = normalizeText(rawPatch.managedVm.vmName);
    const guestAgentBaseUrl = normalizeText(rawPatch.managedVm.guestAgentBaseUrl);
    const streamMode =
      rawPatch.managedVm.streamMode === "sunshine-moonlight"
        ? rawPatch.managedVm.streamMode
        : undefined;

    if (vmName || guestAgentBaseUrl || streamMode) {
      patch.managedVm = {};

      if (vmName) {
        patch.managedVm.vmName = vmName;
      }
      if (guestAgentBaseUrl) {
        patch.managedVm.guestAgentBaseUrl = guestAgentBaseUrl;
      }
      if (streamMode) {
        patch.managedVm.streamMode = streamMode;
      }
    }
  }

  const pinnedGameIds = normalizePinnedGameIds(rawPatch.pinnedGameIds);

  if (pinnedGameIds !== undefined) {
    patch.pinnedGameIds = pinnedGameIds;
  }

  return patch;
}

function mergeConfig(base: HostConfig, patch: unknown): HostConfig {
  const normalizedPatch = normalizeHostConfigPatch(patch);

  return {
    runtimeProvider: normalizedPatch.runtimeProvider ?? base.runtimeProvider,
    managedVm: {
      ...base.managedVm,
      ...normalizedPatch.managedVm,
    },
    pinnedGameIds: normalizedPatch.pinnedGameIds ?? base.pinnedGameIds,
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
