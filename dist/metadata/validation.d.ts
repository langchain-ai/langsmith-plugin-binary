import type { CodingAgentIntegration, CodingAgentMetadataField, CodingAgentRunType, MetadataValidationIssue } from "./models.js";
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function metadataFieldTypeIssue(field: CodingAgentMetadataField, value: unknown): "type" | undefined;
export declare function metadataFieldValueIssue(field: CodingAgentMetadataField, value: unknown): "type" | "value" | undefined;
export declare function validateCodingAgentMetadata(value: unknown, runType: CodingAgentRunType, integration?: CodingAgentIntegration): MetadataValidationIssue[];
export declare function validateProviderMetadata(value: unknown, integration: CodingAgentIntegration, runType: CodingAgentRunType): MetadataValidationIssue[];
export declare function normalizeProviderMetadata(value: unknown, integration: CodingAgentIntegration, runType: CodingAgentRunType): Record<string, unknown>;
//# sourceMappingURL=validation.d.ts.map