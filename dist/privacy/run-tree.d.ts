import { RunTree, type RunTreeConfig } from "langsmith";
import { type CodingAgentIntegration, type CodingAgentMetadataMode } from "../metadata/index.js";
import type { CodingAgentPrivacyContext } from "./models.js";
export declare function createCodingAgentRunTree(config: RunTreeConfig, integration: CodingAgentIntegration, mode?: CodingAgentMetadataMode, privacyContext?: CodingAgentPrivacyContext): RunTree;
export declare function survivingCodingAgentPatchFields(projectedRun: Record<string, unknown>, fields: readonly string[]): string[];
//# sourceMappingURL=run-tree.d.ts.map