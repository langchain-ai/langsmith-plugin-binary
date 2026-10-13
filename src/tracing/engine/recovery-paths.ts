import { join, resolve } from "node:path";
import { identifierHash } from "../../storage/capture/paths.js";
import {
  TRACING_ENGINE_BACKGROUND_RECOVERY_ACCOUNTS_DIRECTORY,
  TRACING_ENGINE_BACKGROUND_RECOVERY_DIRECTORY,
  TRACING_ENGINE_BACKGROUND_RECOVERY_INTEGRATIONS_DIRECTORY,
  TRACING_ENGINE_BACKGROUND_RECOVERY_LOCK_FILE,
  TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_FILE,
} from "./constants.js";
import type { TracingEngineBackgroundRecoveryPaths, TracingEngineScope } from "./models.js";

export function backgroundRecoveryPathSegments(
  scope: Pick<TracingEngineScope, "integration" | "accountFingerprint">,
): string[] {
  return [
    TRACING_ENGINE_BACKGROUND_RECOVERY_DIRECTORY,
    TRACING_ENGINE_BACKGROUND_RECOVERY_INTEGRATIONS_DIRECTORY,
    identifierHash(scope.integration),
    TRACING_ENGINE_BACKGROUND_RECOVERY_ACCOUNTS_DIRECTORY,
    identifierHash(scope.accountFingerprint),
  ];
}

export function backgroundRecoveryPaths(
  storageRoot: string,
  scope: Pick<TracingEngineScope, "integration" | "accountFingerprint">,
): TracingEngineBackgroundRecoveryPaths {
  const directory = join(resolve(storageRoot), ...backgroundRecoveryPathSegments(scope));
  return {
    directory,
    lock: join(directory, TRACING_ENGINE_BACKGROUND_RECOVERY_LOCK_FILE),
    marker: join(directory, TRACING_ENGINE_BACKGROUND_RECOVERY_MARKER_FILE),
  };
}
