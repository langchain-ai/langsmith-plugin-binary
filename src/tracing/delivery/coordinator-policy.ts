import { validateIdentifier } from "../../storage/capture/paths.js";
import {
  DELIVERY_DEFAULT_MAX_AGE_MS,
  DELIVERY_DEFAULT_MAX_ATTEMPTS,
  DELIVERY_DEFAULT_MAX_ENTRIES,
} from "./constants.js";
import type { DeliveryPolicy, DrainOptions } from "./models.js";

export function validateDrainRequest(request: DrainOptions): void {
  if (request.writer === null || typeof request.writer !== "object")
    throw new TypeError("A delivery writer is required");
  validateIdentifier(request.writer.accountFingerprint, "account fingerprint");
  if (!Array.isArray(request.writer.destinations) || request.writer.destinations.length === 0)
    throw new TypeError("At least one delivery destination is required");
  const ids = new Set<string>();
  for (const destination of request.writer.destinations) {
    validateIdentifier(destination.id, "destination");
    if (ids.has(destination.id)) throw new TypeError("Delivery destinations must be unique");
    ids.add(destination.id);
  }
  if (typeof request.writer.send !== "function")
    throw new TypeError("A delivery transport is required");
  if (
    request.now !== undefined &&
    (!Number.isSafeInteger(request.now) || !Number.isFinite(new Date(request.now).getTime()))
  ) {
    throw new TypeError("Invalid delivery clock");
  }
}

export function snapshotWriter(writer: DrainOptions["writer"]): DrainOptions["writer"] {
  if (writer === null || typeof writer !== "object")
    throw new TypeError("A delivery writer is required");
  const accountFingerprint = writer.accountFingerprint;
  const sourceDestinations = writer.destinations;
  const send = writer.send;
  if (!Array.isArray(sourceDestinations) || sourceDestinations.length === 0)
    throw new TypeError("At least one delivery destination is required");
  const destinations = sourceDestinations.map((destination) => {
    if (destination === null || typeof destination !== "object")
      throw new TypeError("Invalid delivery destination");
    return Object.freeze({ id: destination.id });
  });
  return Object.freeze({
    accountFingerprint,
    destinations: Object.freeze(destinations),
    send: typeof send === "function" ? send.bind(writer) : send,
  });
}

export function resolvePolicy(policy: Partial<DeliveryPolicy> | undefined): DeliveryPolicy {
  const resolved = {
    maxAttempts: policy?.maxAttempts ?? DELIVERY_DEFAULT_MAX_ATTEMPTS,
    maxAgeMs: policy?.maxAgeMs ?? DELIVERY_DEFAULT_MAX_AGE_MS,
    maxEntries: policy?.maxEntries ?? DELIVERY_DEFAULT_MAX_ENTRIES,
  };
  if (
    !Number.isSafeInteger(resolved.maxAttempts) ||
    resolved.maxAttempts <= 0 ||
    !Number.isSafeInteger(resolved.maxAgeMs) ||
    resolved.maxAgeMs <= 0 ||
    !Number.isSafeInteger(resolved.maxEntries) ||
    resolved.maxEntries <= 0
  ) {
    throw new TypeError("Invalid delivery policy");
  }
  return resolved;
}
