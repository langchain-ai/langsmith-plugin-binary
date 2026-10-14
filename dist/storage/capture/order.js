import { compareText } from "../../utils/compare.js";
export function compareCaptureOrder(left, right) {
    if (left.capturedAtMs !== right.capturedAtMs)
        return left.capturedAtMs < right.capturedAtMs ? -1 : 1;
    return compareText(left.eventId, right.eventId);
}
//# sourceMappingURL=order.js.map