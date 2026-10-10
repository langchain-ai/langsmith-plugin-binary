import { requireNonBlankString, requireTimestamp } from "../../utils/validation/objects.js";
import {
  DOTTED_ORDER_SEGMENT_PATTERN,
  DOTTED_ORDER_STRIP_PATTERN,
  DOTTED_ORDER_TIME_PREFIX_LENGTH,
  ROOT_RUN_EXECUTION_ORDER,
} from "./constants.js";
import type {
  DottedOrderSegment,
  RunIdentity,
  RunIdentityInput,
  RunParentIdentity,
} from "./models.js";

export function createRunIdentity(input: RunIdentityInput): RunIdentity {
  const id = requireNonBlankString(input.id, "Run ID");
  const start_time = requireTimestamp(input.start_time);
  const segment = dottedOrderSegment(start_time, id);
  if (input.parent === undefined) {
    return { id, start_time, trace_id: id, dotted_order: segment };
  }

  const parent = canonicalParent(input.parent);
  return {
    id,
    start_time,
    parent_run_id: parent.id,
    trace_id: parent.trace_id,
    dotted_order: `${parent.dotted_order}.${segment}`,
  };
}

function canonicalParent(parent: RunParentIdentity): RunParentIdentity {
  const id = requireNonBlankString(parent.id, "Parent run ID");
  const trace_id = requireNonBlankString(parent.trace_id, "Parent trace ID");
  const dotted_order = requireNonBlankString(parent.dotted_order, "Parent dotted order");
  const parent_run_id =
    parent.parent_run_id === undefined
      ? undefined
      : requireNonBlankString(parent.parent_run_id, "Parent run's parent ID");
  const segments = dotted_order.split(".").map(parseDottedOrderSegment);
  const runIds = segments.map((segment) => segment.runId);
  const lastSegment = segments.at(-1);
  const start_time =
    parent.start_time === undefined ? undefined : requireTimestamp(parent.start_time);
  if (
    lastSegment?.runId !== id ||
    runIds[0] !== trace_id ||
    (parent_run_id !== undefined && (runIds.length < 2 || runIds.at(-2) !== parent_run_id)) ||
    (start_time !== undefined &&
      lastSegment.timestamp.slice(0, DOTTED_ORDER_TIME_PREFIX_LENGTH) !==
        dottedOrderTimePrefix(start_time))
  ) {
    throw new TypeError("Parent run identity is not canonical");
  }
  return {
    id,
    ...(parent_run_id === undefined ? {} : { parent_run_id }),
    trace_id,
    dotted_order,
    ...(start_time === undefined ? {} : { start_time }),
  };
}

function parseDottedOrderSegment(segment: string): DottedOrderSegment {
  const match = DOTTED_ORDER_SEGMENT_PATTERN.exec(segment);
  if (match === null || !isValidDottedOrderTime(match[1]!)) {
    throw new TypeError("Parent run identity is not canonical");
  }
  return { timestamp: match[1]!, runId: match[2]! };
}

function isValidDottedOrderTime(value: string): boolean {
  const time = value.slice(0, DOTTED_ORDER_TIME_PREFIX_LENGTH);
  const iso = `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}T${time.slice(9, 11)}:${time.slice(11, 13)}:${time.slice(13, 15)}.${time.slice(15, 18)}Z`;
  const parsed = new Date(iso);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === iso;
}

function dottedOrderTimePrefix(startTime: number | string): string {
  return new Date(startTime).toISOString().slice(0, -1).replace(DOTTED_ORDER_STRIP_PATTERN, "");
}

function dottedOrderSegment(startTime: number | string, runId: string): string {
  const epoch = new Date(startTime).getTime();
  const serialized = new Date(epoch).toISOString().slice(0, -1);
  const precisionTime = `${serialized}${String(ROOT_RUN_EXECUTION_ORDER).padStart(3, "0")}Z`;
  return `${precisionTime.replace(DOTTED_ORDER_STRIP_PATTERN, "")}${runId}`;
}
