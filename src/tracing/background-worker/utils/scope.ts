import type { BackgroundWorkerOptions, BackgroundWorkerScope } from "../models.js";

export async function matchesScope(
  resolveScope: BackgroundWorkerOptions["resolveScope"],
  expected: BackgroundWorkerScope,
): Promise<boolean> {
  const actual = await resolveScope();
  return (
    actual.integration === expected.integration &&
    actual.sessionId === expected.sessionId &&
    actual.accountFingerprint === expected.accountFingerprint
  );
}
