import type { CaptureScope, CaptureStore } from "../../storage/capture/models.js";
import type { ReconstructionCandidate, ReconstructionJob, ReconstructionJobContext, ReconstructionJobProcessResult, ReconstructionTerminalOutcome } from "./models.js";
export declare function processJob(candidate: ReconstructionCandidate, context: ReconstructionJobContext): Promise<ReconstructionJobProcessResult>;
export declare function removeJob(store: CaptureStore, job: ReconstructionJob): Promise<void>;
export declare function recordTerminal(store: CaptureStore, scope: CaptureScope, accountFingerprint: string, outcome: ReconstructionTerminalOutcome, reason?: string): Promise<boolean>;
//# sourceMappingURL=job-processing.d.ts.map