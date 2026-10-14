import { UPLOAD_ALREADY_RECEIVED_MESSAGE, UPLOAD_ALREADY_RECEIVED_STATUS } from "./constants.js";
function failureStatus(cause) {
    const status = cause?.status;
    return typeof status === "number" ? status : undefined;
}
export function isAlreadyReceived(cause) {
    return (failureStatus(cause) === UPLOAD_ALREADY_RECEIVED_STATUS &&
        String(cause.message).includes(UPLOAD_ALREADY_RECEIVED_MESSAGE));
}
//# sourceMappingURL=errors.js.map