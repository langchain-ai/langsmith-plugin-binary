import { TRACING_ENGINE_MISSING_SETTLEMENT_CAPTURE_MESSAGE } from "./constants.js";

export class MissingSettlementCaptureError extends Error {
  constructor() {
    super(TRACING_ENGINE_MISSING_SETTLEMENT_CAPTURE_MESSAGE);
    this.name = "MissingSettlementCaptureError";
  }
}
