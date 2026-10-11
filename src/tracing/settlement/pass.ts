import type { CaptureScope, OutcomeReadResult } from "../../storage/capture/models.js";
import {
  LIFECYCLE_PATCH_EVENT_KIND,
  LIFECYCLE_POST_EVENT_KIND,
  LIFECYCLE_SETTLEMENT_EVENT_KIND,
} from "../lifecycle/constants.js";
import { captureReadiness } from "./readiness.js";
import { projectCapture } from "./projection.js";
import { settleOneTurn } from "./settle-turn.js";
import { groupByTurn, orderSourceCaptures } from "./source-order.js";
import type {
  ProjectedCapture,
  SettleCapturedTurnsOptions,
  TurnSettlementPlannedPatch,
  TurnSettlementProgress,
  TurnSettlementReport,
  TurnSettlementWork,
} from "./models.js";

export async function settleCapturedTurns(
  options: SettleCapturedTurnsOptions,
): Promise<TurnSettlementWork> {
  if (options.destinations.length === 0)
    throw new TypeError("At least one settlement destination is required");
  const sourceRecords = orderSourceCaptures(
    options.captures
      .map(({ record }) => record)
      .filter(
        (record) =>
          record.integration === options.integration &&
          record.sessionId === options.sessionId &&
          record.destinationFingerprint === options.destinationFingerprint &&
          (record.eventKind === LIFECYCLE_POST_EVENT_KIND ||
            record.eventKind === LIFECYCLE_PATCH_EVENT_KIND),
      ),
  );
  const generatedRecords = options.captures
    .map(({ record }) => record)
    .filter(
      (record) =>
        record.integration === options.integration &&
        record.sessionId === options.sessionId &&
        record.destinationFingerprint === options.destinationFingerprint &&
        record.eventKind === LIFECYCLE_SETTLEMENT_EVENT_KIND,
    );
  const projected = new Map<string, ProjectedCapture[]>();
  const allByRunId = new Map<string, ProjectedCapture[]>();
  for (const record of sourceRecords) {
    const capture = projectCapture(record, options.integration);
    if (capture === undefined) continue;
    const turn = projected.get(record.turnId) ?? [];
    turn.push(capture);
    projected.set(record.turnId, turn);
    const runEvents = allByRunId.get(record.runId) ?? [];
    runEvents.push(capture);
    allByRunId.set(record.runId, runEvents);
  }
  const generatedByTurn = groupByTurn(generatedRecords);
  const turns = [...new Set([...projected.keys(), ...generatedByTurn.keys()])].toSorted();
  const reports: TurnSettlementReport[] = [];
  const patches: TurnSettlementPlannedPatch[] = [];
  let captured = 0;
  for (const turnId of turns) {
    const events = projected.get(turnId) ?? [];
    const generated = generatedByTurn.get(turnId) ?? [];
    const result = await settleOneTurn(turnId, events, generated, allByRunId, options);
    reports.push(result.report);
    patches.push(...result.patches);
    captured += result.captured;
  }
  return { progress: { captured, turns: reports }, patches };
}

export async function refreshSettlementProgress(
  work: TurnSettlementWork,
  destinations: SettleCapturedTurnsOptions["destinations"],
  readOutcome: (scope: CaptureScope, destination: string) => Promise<OutcomeReadResult>,
): Promise<TurnSettlementProgress> {
  const patchesByTurn = new Map<string, TurnSettlementPlannedPatch[]>();
  for (const patch of work.patches) {
    const turn = patchesByTurn.get(patch.turnId) ?? [];
    turn.push(patch);
    patchesByTurn.set(patch.turnId, turn);
  }
  const turns: TurnSettlementReport[] = [];
  for (const entry of work.progress.turns) {
    const patches = patchesByTurn.get(entry.turnId) ?? [];
    if (patches.length === 0 || (entry.status !== "pending" && entry.status !== "settled")) {
      turns.push(entry);
      continue;
    }
    const readiness = await captureReadiness(
      patches.map(({ scope }) => scope),
      destinations,
      readOutcome,
    );
    const { reason: previousReason, destinations: previousDestinations, ...unchanged } = entry;
    const reason =
      readiness.status === "delivered"
        ? previousReason === "settlement-pending"
          ? undefined
          : previousReason
        : readiness.status === "dropped"
          ? "settlement-dropped"
          : "settlement-pending";
    const reportDestinations =
      readiness.destinations.length > 0
        ? readiness.destinations
        : previousReason === "settlement-pending"
          ? undefined
          : previousDestinations;
    turns.push({
      ...unchanged,
      status:
        readiness.status === "dropped"
          ? "blocked"
          : readiness.status === "pending"
            ? "pending"
            : "settled",
      ...(reason === undefined ? {} : { reason }),
      ...(reportDestinations === undefined ? {} : { destinations: reportDestinations }),
    });
  }
  return { captured: work.progress.captured, turns };
}
