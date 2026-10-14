import type { ReconstructionJob, ReconstructionJobInput, ReconstructionSourceSnapshot, ReconstructionTurnEvidence, ReconstructionValidatedOutput } from "./models.js";
export declare function validateOutputs(value: unknown, job: ReconstructionJob, jobCapturedAtMs: number): ReconstructionValidatedOutput[];
export declare function validateJobInput(value: ReconstructionJobInput, integration: ReconstructionJob["integration"], sessionId: string, accountFingerprint: string): ReconstructionJob;
export declare function validateSourceSnapshots(value: unknown, integration: ReconstructionJob["integration"], privacyMode: ReconstructionJob["privacyMode"], sourceRefs: readonly string[]): ReconstructionSourceSnapshot[];
export declare function validateTurnEvidence(value: unknown): ReconstructionTurnEvidence;
//# sourceMappingURL=job-validation.d.ts.map