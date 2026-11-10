import { createHash } from "node:crypto";
import type { CaptureInput, StoredCapture } from "../models.js";
import { canonicalJson } from "./serialization.js";

export function captureContentDigest(record: CaptureInput | StoredCapture): string {
  if ("contentDigest" in record && record.contentDigest !== undefined) return record.contentDigest;
  const content: Record<string, unknown> = { ...record };
  delete content.version;
  delete content.capturedAtMs;
  delete content.delivery;
  delete content.destinationRoutes;
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}
