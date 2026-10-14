import { UPLOAD_DOTTED_ORDER_SEGMENT } from "./constants.js";
function startTimeFromDottedOrder(dottedOrder) {
    if (typeof dottedOrder !== "string")
        return undefined;
    const own = dottedOrder.slice(dottedOrder.lastIndexOf(".") + 1);
    const match = UPLOAD_DOTTED_ORDER_SEGMENT.exec(own);
    if (match === null)
        return undefined;
    const [, year, month, day, hour, minute, second, micros] = match;
    return `${year}-${month}-${day}T${hour}:${minute}:${second}.${micros}Z`;
}
export function startTimeText(supplied, dottedOrder) {
    if (typeof supplied === "string")
        return supplied;
    if (typeof supplied === "number")
        return new Date(supplied).toISOString();
    return startTimeFromDottedOrder(dottedOrder);
}
//# sourceMappingURL=timestamps.js.map