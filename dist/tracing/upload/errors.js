import { describe, failureStatus } from "../../utils/errors.js";
import { UPLOAD_ALREADY_RECEIVED_MESSAGE, UPLOAD_ALREADY_RECEIVED_STATUS, UPLOAD_ERROR_NAME, UPLOAD_FAILED_MESSAGE, UPLOAD_RETRYABLE_STATUSES, UPLOAD_SERVER_ERROR_MIN_STATUS, } from "./constants.js";
export class UploadError extends Error {
    retryable;
    status;
    constructor(cause) {
        super(UPLOAD_FAILED_MESSAGE, { cause });
        this.name = UPLOAD_ERROR_NAME;
        const status = failureStatus(cause);
        this.status = status;
        this.retryable =
            status === undefined ||
                status >= UPLOAD_SERVER_ERROR_MIN_STATUS ||
                UPLOAD_RETRYABLE_STATUSES.includes(status);
    }
}
export function isAlreadyReceived(cause) {
    return (failureStatus(cause) === UPLOAD_ALREADY_RECEIVED_STATUS &&
        describe(cause).includes(UPLOAD_ALREADY_RECEIVED_MESSAGE));
}
//# sourceMappingURL=errors.js.map