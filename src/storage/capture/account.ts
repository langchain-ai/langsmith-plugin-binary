import type { StoredCapture } from "./models.js";

export function isWaitingForOtherSetting(
  record: StoredCapture,
  accountFingerprint: string,
): boolean {
  return (
    record.destinationFingerprint !== accountFingerprint &&
    Object.keys(record.delivery?.outcomes ?? {}).length === 0
  );
}
