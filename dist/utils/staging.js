import { KERNEL_LOG_COMMAND } from "../constants.js";
import { describe } from "./errors.js";
function keptLine(staged) {
    return staged
        ? `\nThe copy it tried to run is kept at ${staged} so you can run it yourself.`
        : "";
}
export function worthRetrying(failure) {
    return failure.kind === "stopped";
}
export function worthKeeping(failure) {
    return failure.kind !== "exit";
}
export function whyTheVersionIsWrong(reported, expected) {
    return `The downloaded binary reports version ${reported}, expected ${expected}.`;
}
export function whyTheSignatureStoppedMatching(error, staged) {
    return `The downloaded binary no longer matches the signature we published (${describe(error)}), so something altered the file after it landed here.${keptLine(staged)}`;
}
export function whyTheVersionCheckFailed(failure, staged) {
    switch (failure.kind) {
        case "stopped":
            return [
                `The system killed the downloaded binary with ${failure.signal} before it could report its version, so something stopped the program rather than the program going wrong.`,
                `Run ${KERNEL_LOG_COMMAND} to see what the system says about it, and nothing there means the kill came from somewhere else.${keptLine(staged)}`,
            ].join("\n");
        case "crashed":
            return `The downloaded binary crashed with ${failure.signal} before it could report its version, so the program itself failed rather than anything stopping it.${keptLine(staged)}`;
        case "timeout":
            return `The downloaded binary did not report its version, and gave up waiting after ${failure.seconds} seconds.${keptLine(staged)}`;
        case "exit":
            return `The downloaded binary exited with code ${failure.status} instead of reporting its version.`;
        case "start":
            return `The downloaded binary could not be started (${failure.detail}).${keptLine(staged)}`;
        default:
            return `The downloaded binary did not report its version (${failure.detail}).${keptLine(staged)}`;
    }
}
//# sourceMappingURL=staging.js.map