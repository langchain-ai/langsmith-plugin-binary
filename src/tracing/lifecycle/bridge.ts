import { resolve } from "node:path";
import { createCaptureStore } from "../../storage/capture/index.js";
import type { CaptureScope, JsonValue, StoredCapture } from "../../storage/capture/models.js";
import { createDeliveryCoordinator } from "../delivery/index.js";
import { createLangSmithUploadWriter } from "../upload/index.js";
import type { NormalizedRunContext, PreparedRunSubmission } from "../upload/models.js";
import {
  canonicalJsonObject,
  canonicalJsonValue,
  ownDataField,
  requireNonBlankString,
  requireOwnDataField,
  requirePlainRecord,
  requireStringArray,
  requireTimestamp,
} from "../../utils/validation/objects.js";
import { snapshotData } from "../../utils/validation/snapshot.js";
import type {
  LifecycleBridge,
  LifecycleBridgeOptions,
  LifecycleCaptureInput,
  LifecycleCaptureResult,
  LifecycleDrainInput,
  LifecycleTurnEvidence,
} from "./models.js";
import {
  LIFECYCLE_PATCH_EVENT_KIND,
  LIFECYCLE_POST_EVENT_KIND,
  LIFECYCLE_TURN_CLOSURE_STATES,
} from "./constants.js";
import { projectSubmission } from "./projection.js";

export function createLifecycleBridge(options: LifecycleBridgeOptions): LifecycleBridge {
  const integration = options.integration;
  const wake = options.wake;
  const sessionId = requireNonBlankString(options.sessionId, "Session ID");
  const storageRoot = resolve(options.storageRoot);
  const captureStore = createCaptureStore(storageRoot);
  const coordinator = createDeliveryCoordinator({
    storageRoot,
    integration,
    sessionId,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
  });
  const writer = createLangSmithUploadWriter(options.writer);
  return Object.freeze({
    accountFingerprint: writer.accountFingerprint,
    async capture(input: LifecycleCaptureInput): Promise<LifecycleCaptureResult> {
      const capture = requirePlainRecord(
        snapshotData(requirePlainRecord(input, "Lifecycle capture")),
        "Lifecycle capture",
      );
      const turnId = requireNonBlankString(capture["turnId"], "Turn ID");
      const eventId = requireNonBlankString(capture["eventId"], "Event ID");
      const scope: CaptureScope = { integration, sessionId, turnId, eventId };
      const previous = await captureStore.read(scope);
      const projected = projectSubmission(
        capture["submission"],
        integration,
        previous === undefined ? undefined : previousRunContext(previous),
      );
      if (projected.status === "deferred") {
        return { status: "deferred", reason: "missing-thread-identity" };
      }
      const turnEvidence = projectTurnEvidence(
        capture["turnEvidence"],
        projected.value.payload.privacyMode,
      );
      const dependencies = capture["dependencies"] as LifecycleCaptureInput["dependencies"];
      const identityPresence =
        projected.value.payload.operation === "post"
          ? suppliedRunIdentityFields(capture["submission"])
          : undefined;
      const captureProjected = (value: typeof projected.value) =>
        coordinator.capture({
          turnId,
          eventId,
          runId: value.payload.run.id,
          destinationFingerprint: writer.accountFingerprint,
          eventKind:
            value.payload.operation === "post"
              ? LIFECYCLE_POST_EVENT_KIND
              : LIFECYCLE_PATCH_EVENT_KIND,
          normalizedPayload: canonicalJsonValue(value.payload),
          turnEvidence,
          metadataProvenance: canonicalJsonValue(value.metadata),
          ...(dependencies === undefined ? {} : { dependencies }),
        });
      let result = await captureProjected(projected.value);
      if (
        result.status === "conflict" &&
        previous === undefined &&
        identityPresence !== undefined &&
        projected.value.payload.operation === "post"
      ) {
        const winner = await captureStore.read(scope);
        if (winner?.runId === projected.value.payload.run.id) {
          const run = { ...projected.value.payload.run };
          if (!identityPresence.startTime) delete run.start_time;
          if (!identityPresence.traceId) delete run.trace_id;
          if (!identityPresence.dottedOrder) delete run.dotted_order;
          const retry = projectSubmission(
            { ...projected.value.payload, run, metadata: projected.value.metadata },
            integration,
            previousRunContext(winner),
          );
          if (retry.status === "ready") result = await captureProjected(retry.value);
        }
      }
      if (result.status === "published" || result.status === "duplicate") await wake?.();
      return result;
    },
    async drain(input: LifecycleDrainInput = {}) {
      const result = await coordinator.drain({
        writer: {
          accountFingerprint: writer.accountFingerprint,
          destinations: writer.destinations,
          async send(record, destination, fingerprint) {
            if (fingerprint !== writer.accountFingerprint)
              throw new Error("Upload account changed");
            const submission = restoreSubmission(record, integration);
            await writer.send(submission, destination.id);
          },
        },
        ...(input.now === undefined ? {} : { now: input.now }),
      });
      if (result.status === "drained" && result.delivered + result.dropped > 0) {
        await wake?.();
      }
      return result;
    },
  });
}

function suppliedRunIdentityFields(value: unknown) {
  const source = requirePlainRecord(value, "Prepared run submission");
  const run = requirePlainRecord(requireOwnDataField(source, "run"), "Normalized run snapshot");
  const supplied = (key: string) => {
    const field = ownDataField(run, key);
    return field.present && field.value !== undefined;
  };
  return {
    startTime: supplied("start_time"),
    traceId: supplied("trace_id"),
    dottedOrder: supplied("dotted_order"),
  };
}

function previousRunContext(record: StoredCapture): NormalizedRunContext {
  const payload = requirePlainRecord(record.normalizedPayload, "Stored run payload");
  const runField = ownDataField(payload, "run");
  if (!runField.present) throw new TypeError("Stored run context is required");
  const run = requirePlainRecord(runField.value, "Stored run context");
  const context: NormalizedRunContext = {
    id: requireNonBlankString(run["id"], "Run ID"),
    name: requireNonBlankString(run["name"], "Run name"),
    run_type: requireNonBlankString(run["run_type"], "Run type"),
  };
  const startTime = ownDataField(run, "start_time");
  if (startTime.present && startTime.value !== undefined)
    context.start_time = requireTimestamp(startTime.value);
  const parentRunId = ownDataField(run, "parent_run_id");
  if (parentRunId.present && parentRunId.value !== undefined) {
    context.parent_run_id = requireNonBlankString(parentRunId.value, "Parent run ID");
  }
  const traceId = ownDataField(run, "trace_id");
  if (traceId.present && traceId.value !== undefined) {
    context.trace_id = requireNonBlankString(traceId.value, "Trace ID");
  }
  const dottedOrder = ownDataField(run, "dotted_order");
  if (dottedOrder.present && dottedOrder.value !== undefined) {
    context.dotted_order = requireNonBlankString(dottedOrder.value, "Dotted order");
  }
  return context;
}

function projectTurnEvidence(value: unknown, mode: "full" | "metadata"): JsonValue {
  const source = requirePlainRecord(value, "Lifecycle turn evidence");
  const childRunIds = requireStringArray(
    requireOwnDataField(source, "childRunIds"),
    "Child run IDs",
  ).map((runId) => requireNonBlankString(runId, "Child run ID"));
  const closureState = requireOwnDataField(source, "closureState");
  if (
    typeof closureState !== "string" ||
    !LIFECYCLE_TURN_CLOSURE_STATES.includes(closureState as LifecycleTurnEvidence["closureState"])
  ) {
    throw new TypeError("Lifecycle turn evidence has an invalid closure state");
  }
  const structural: LifecycleTurnEvidence = {
    childRunIds,
    closureState: closureState as LifecycleTurnEvidence["closureState"],
  };
  return canonicalJsonValue(mode === "metadata" ? structural : source);
}

function restoreSubmission(
  record: StoredCapture,
  integration: LifecycleBridgeOptions["integration"],
): PreparedRunSubmission {
  const payload = canonicalJsonObject(record.normalizedPayload, "Stored run payload");
  if (payload["integration"] !== integration)
    throw new TypeError("Stored integration does not match the lifecycle bridge");
  if (payload["run"] === null || typeof payload["run"] !== "object") {
    throw new TypeError("Stored run data is required");
  }
  const run = payload["run"] as Record<string, unknown>;
  if (run["id"] !== record.runId) throw new TypeError("Stored run ID does not match its capture");
  const mode = payload["privacyMode"];
  if (mode !== "full" && mode !== "metadata") throw new TypeError("Stored privacy mode is invalid");
  const projected = projectSubmission(
    { ...payload, metadata: record.metadataProvenance },
    integration,
  );
  if (projected.status === "deferred")
    throw new TypeError("Stored capture is missing thread identity");
  return { ...projected.value.payload, metadata: projected.value.metadata };
}
