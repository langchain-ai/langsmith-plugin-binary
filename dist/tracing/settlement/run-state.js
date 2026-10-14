import { requireTimestamp } from "../../utils/validation/objects.js";
export function hasCausalRunError(events) {
    let hasError = false;
    for (const event of events)
        hasError = causalErrorAfter(event, hasError);
    return hasError;
}
function causalErrorAfter(event, previous) {
    const { payload } = event;
    if (payload.operation === "post")
        return payload.run.error !== undefined || payload.privacyContext?.status === "error";
    if (payload.patch.fields.includes("error"))
        return payload.patch.values.error !== undefined;
    if (payload.privacyContext.status === "error")
        return true;
    return previous;
}
export function capturedEndTime(event) {
    if (event.payload.operation === "post")
        return event.payload.run.end_time;
    if (!event.payload.patch.fields.includes("end_time"))
        return undefined;
    const value = event.payload.patch.values.end_time;
    return value === undefined ? undefined : requireTimestamp(value);
}
export function retainedEndTime(events) {
    let endTime;
    for (const event of events) {
        const captured = capturedEndTime(event);
        if (captured !== undefined)
            endTime = captured;
    }
    return endTime;
}
//# sourceMappingURL=run-state.js.map