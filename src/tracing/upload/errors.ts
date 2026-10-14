import { UPLOAD_ALREADY_RECEIVED_MESSAGE, UPLOAD_ALREADY_RECEIVED_STATUS } from "./constants.js";
import type { UploadFailure } from "./models.js";

function failureStatus(cause: unknown): number | undefined {
  const status = (cause as UploadFailure | undefined)?.status;
  return typeof status === "number" ? status : undefined;
}

export function isAlreadyReceived(cause: unknown): boolean {
  return (
    failureStatus(cause) === UPLOAD_ALREADY_RECEIVED_STATUS &&
    String((cause as Error).message).includes(UPLOAD_ALREADY_RECEIVED_MESSAGE)
  );
}
