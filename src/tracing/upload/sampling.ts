import { createHash } from "node:crypto";
import {
  UPLOAD_DOTTED_ORDER_ROOT_ID,
  UPLOAD_SAMPLING_BUCKET_BYTES,
  UPLOAD_SAMPLING_HASH,
  UPLOAD_SAMPLING_RATE_VARIABLES,
} from "./constants.js";
import type { NormalizedRunContext, PreparedUploadItem } from "./models.js";

export function samplingRate(environment: NodeJS.ProcessEnv): number | undefined {
  for (const name of UPLOAD_SAMPLING_RATE_VARIABLES) {
    const value = environment[name]?.trim();
    if (value === undefined || value === "") continue;
    const rate = Number(value);
    return Number.isFinite(rate) ? rate : undefined;
  }
  return undefined;
}

export function isSampled(item: PreparedUploadItem, rate: number | undefined): boolean {
  if (rate === undefined || rate >= 1) return true;
  const traceId = traceIdOf(item.submission.run);
  const digest = createHash(UPLOAD_SAMPLING_HASH).update(traceId.toLowerCase()).digest();
  return (
    digest.readUIntBE(0, UPLOAD_SAMPLING_BUCKET_BYTES) / 2 ** (8 * UPLOAD_SAMPLING_BUCKET_BYTES) <
    rate
  );
}

function traceIdOf(run: NormalizedRunContext): string {
  return run.trace_id ?? UPLOAD_DOTTED_ORDER_ROOT_ID.exec(run.dotted_order ?? "")?.[1] ?? run.id;
}
