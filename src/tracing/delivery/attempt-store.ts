import { join, resolve } from "node:path";
import { DELIVERY_ATTEMPT_VERSION } from "./constants.js";
import type { DeliveryAttempt, DeliveryAttemptStore } from "./models.js";
import {
  ensurePrivateDirectory,
  publishExclusive,
  readPrivateFile,
} from "../../storage/capture/utils/atomic-file.js";
import { listPrivateDirectory } from "../../utils/files/private-directory.js";
import { attemptDirectory, attemptSegments } from "./utils/paths.js";
import {
  readAttemptFileNumber,
  validateAttemptSequence,
  parseAttempt,
  requireAttemptNumber,
  sameAttempt,
  validateAttemptScope,
  validateTimestamp,
} from "./utils/validation.js";

export function createDeliveryAttemptStore(root: string): DeliveryAttemptStore {
  const storageRoot = resolve(root);
  return {
    async count(scope, destination) {
      validateAttemptScope(scope, destination);
      const directory = attemptDirectory(storageRoot, scope, destination);
      const entries = await listPrivateDirectory(storageRoot, directory);
      if (entries === undefined) return 0;
      const attempts: number[] = [];
      for (const entry of entries) {
        const attempt = readAttemptFileNumber(entry);
        if (attempt === undefined) continue;
        const contents = await readPrivateFile(storageRoot, join(directory, entry.name));
        if (contents === undefined) throw new Error("Delivery attempt disappeared");
        const record = parseAttempt(contents);
        if (!sameAttempt(record, scope, destination, attempt))
          throw new Error("Delivery attempt namespace does not match");
        attempts.push(attempt);
      }
      validateAttemptSequence(attempts);
      return attempts.length;
    },
    async record(scope, destination, attempt, startedAt) {
      validateAttemptScope(scope, destination);
      requireAttemptNumber(attempt);
      validateTimestamp(startedAt);
      const directory = attemptDirectory(storageRoot, scope, destination);
      await ensurePrivateDirectory(storageRoot, attemptSegments(scope, destination));
      const record: DeliveryAttempt = {
        version: DELIVERY_ATTEMPT_VERSION,
        ...scope,
        destination,
        attempt,
        startedAt,
      };
      const published = await publishExclusive(
        join(directory, `${attempt}.json`),
        JSON.stringify(record),
      );
      if (!published) throw new Error("Delivery attempt already exists");
    },
  };
}
