import { fillTemplate } from "../../utils/format.js";
import {
  CAPTURE_EXPIRED_WARNING,
  CAPTURE_HELD_EXPIRED_WARNING,
  CAPTURE_TURN_CEILING_MS,
} from "./constants.js";
import { isWaitingForOtherSetting } from "./account.js";
import type { CaptureLiveTurnSpan, EnumeratedCapture, ExpiredCaptureOptions } from "./models.js";

function liveTurnSpans(captures: readonly EnumeratedCapture[]): Map<string, CaptureLiveTurnSpan> {
  const spans = new Map<string, CaptureLiveTurnSpan>();
  for (const { record, capturedAtMs } of captures) {
    if (record.sourceAgeStartedAtMs !== undefined) continue;
    const span = spans.get(record.turnId) ?? { firstMs: capturedAtMs, latestMs: capturedAtMs };
    spans.set(record.turnId, {
      firstMs: Math.min(span.firstMs, capturedAtMs),
      latestMs: Math.max(span.latestMs, capturedAtMs),
    });
  }
  return spans;
}

function expiryOf(
  { record, capturedAtMs }: EnumeratedCapture,
  spans: ReadonlyMap<string, CaptureLiveTurnSpan>,
  options: ExpiredCaptureOptions,
): "age" | "ceiling" | undefined {
  const span = spans.get(record.turnId);
  if (
    record.sourceAgeStartedAtMs === undefined &&
    span !== undefined &&
    options.now - span.firstMs >= CAPTURE_TURN_CEILING_MS
  )
    return "ceiling";
  const startedAtMs = record.sourceAgeStartedAtMs ?? span?.latestMs ?? capturedAtMs;
  return options.now - startedAtMs >= options.maxAgeMs ? "age" : undefined;
}

export async function removeExpiredCaptures(options: ExpiredCaptureOptions): Promise<number> {
  let dropped = 0;
  let pastCeiling = 0;
  let otherSetting = 0;
  let held = 0;
  for (const { captures } of await options.store.enumerateSessions(options.integration)) {
    const spans = liveTurnSpans(captures);
    const expiring = captures.flatMap((capture) => {
      const reason = expiryOf(capture, spans, options);
      return reason === undefined ? [] : [{ record: capture.record, reason }];
    });
    const sessionKeepsCaptures = expiring.length < captures.length;
    for (const { record, reason } of expiring) {
      if (options.heldUpdate?.(record, captures)) held += 1;
      await options.store.remove(record, { forgetTurn: !sessionKeepsCaptures });
      if (options.destinations.every((id) => record.delivery?.outcomes[id] !== undefined)) continue;
      dropped += 1;
      if (reason === "ceiling") pastCeiling += 1;
      if (
        options.accountFingerprint !== undefined &&
        isWaitingForOtherSetting(record, options.accountFingerprint)
      )
        otherSetting += 1;
    }
  }
  await options.store.removeStaleMarkers(options.integration, options.now - options.maxAgeMs);
  if (dropped > 0)
    console.warn(
      fillTemplate(CAPTURE_EXPIRED_WARNING, { dropped, ceiling: pastCeiling, otherSetting }),
    );
  if (held > 0) console.warn(fillTemplate(CAPTURE_HELD_EXPIRED_WARNING, { held }));
  return dropped;
}
