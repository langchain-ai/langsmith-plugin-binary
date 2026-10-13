import { createHash } from "node:crypto";
import { computeRunIdForSecondaryReplica } from "langsmith";
import {
  UPLOAD_REPLICA_DOTTED_ORDER_ID_LENGTH,
  UPLOAD_REPLICA_UUID_V5_DOMAIN,
  UPLOAD_REPLICA_UUID_V5_NAMESPACE_BYTES,
  UPLOAD_REPLICA_UUID_V7_PATTERN,
  UPLOAD_UUID_PATTERN,
} from "./constants.js";
import type { NormalizedRunContext, ResolvedUploadDestination } from "./models.js";

export function contextForDestination(
  context: NormalizedRunContext,
  destination: ResolvedUploadDestination,
): NormalizedRunContext {
  if (destination.sourceProjectName === undefined) return context;
  return remapReplicaRunContext(context, destination.sourceProjectName, destination.projectName);
}

export function runIdForDestination(runId: string, destination: ResolvedUploadDestination): string {
  if (
    destination.sourceProjectName === undefined ||
    destination.sourceProjectName === destination.projectName
  ) {
    return runId;
  }
  return remapReplicaRunId(runId, destination.projectName);
}

export function remapReplicaRunContext(
  context: NormalizedRunContext,
  sourceProjectName: string,
  destinationProjectName: string,
): NormalizedRunContext {
  if (sourceProjectName === destinationProjectName) return context;
  return {
    ...context,
    id: remapReplicaRunId(context.id, destinationProjectName),
    ...(context.parent_run_id === undefined
      ? {}
      : { parent_run_id: remapReplicaRunId(context.parent_run_id, destinationProjectName) }),
    ...(context.trace_id === undefined
      ? {}
      : { trace_id: remapReplicaRunId(context.trace_id, destinationProjectName) }),
    ...(context.dotted_order === undefined
      ? {}
      : { dotted_order: remapReplicaDottedOrder(context.dotted_order, destinationProjectName) }),
  };
}

export function remapReplicaRunId(runId: string, projectName: string): string {
  if (!UPLOAD_UUID_PATTERN.test(runId)) throw new TypeError("Replica run IDs must be UUIDs");
  if (UPLOAD_REPLICA_UUID_V7_PATTERN.test(runId)) {
    return computeRunIdForSecondaryReplica(runId, projectName);
  }
  const name = JSON.stringify([UPLOAD_REPLICA_UUID_V5_DOMAIN, projectName, runId.toLowerCase()]);
  const hash = createHash("sha1")
    .update(UPLOAD_REPLICA_UUID_V5_NAMESPACE_BYTES)
    .update(name)
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const value = hash.subarray(0, 16).toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function remapReplicaDottedOrder(dottedOrder: string, projectName: string): string {
  return dottedOrder
    .split(".")
    .map((segment) => {
      const id = segment.slice(-UPLOAD_REPLICA_DOTTED_ORDER_ID_LENGTH);
      return `${segment.slice(0, -UPLOAD_REPLICA_DOTTED_ORDER_ID_LENGTH)}${remapReplicaRunId(id, projectName)}`;
    })
    .join(".");
}
