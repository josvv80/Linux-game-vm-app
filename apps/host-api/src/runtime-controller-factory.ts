import type { HostConfig } from "@game-vm-hub/shared-types";
import { createFakeEnvironment, ManagedVmController } from "@game-vm-hub/runtime-sdk";

export type RuntimeController = ReturnType<typeof createFakeEnvironment> | ManagedVmController;

export function createRuntimeController(config: HostConfig): RuntimeController {
  if (config.runtimeProvider === "managed-vm") {
    return new ManagedVmController(config);
  }

  return createFakeEnvironment();
}
