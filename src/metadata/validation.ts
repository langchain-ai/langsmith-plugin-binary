import { isPlainRecord } from "../utils/validation/objects.js";
import { CODING_AGENT_V1_CONTRACT } from "./contract.js";
import type {
  CodingAgentIntegration,
  CodingAgentMetadataField,
  CodingAgentRunType,
  MetadataValidationIssue,
} from "./models.js";

export function metadataFieldTypeIssue(
  field: CodingAgentMetadataField,
  value: unknown,
): "type" | undefined {
  const matchesType =
    field.type === "string"
      ? typeof value === "string" && value.length > 0
      : field.type === "integer"
        ? typeof value === "number" && Number.isSafeInteger(value) && value >= 1
        : isPlainRecord(value);
  if (!matchesType) return "type";
  return undefined;
}

function metadataFieldValueIssue(
  field: CodingAgentMetadataField,
  value: unknown,
): "type" | "value" | undefined {
  const typeIssue = metadataFieldTypeIssue(field, value);
  if (typeIssue) return typeIssue;
  if (field.allowedValues && !field.allowedValues.includes(value)) return "value";
  return undefined;
}

export function validateProviderMetadata(
  value: unknown,
  integration: CodingAgentIntegration,
  runType: CodingAgentRunType,
): MetadataValidationIssue[] {
  if (!isPlainRecord(value)) return [{ key: "", reason: "type" }];
  const issues: MetadataValidationIssue[] = [];
  for (const [key, entry] of Object.entries(value)) {
    const field = CODING_AGENT_V1_CONTRACT.keys.find((candidate) => candidate.key === key);
    if (field?.metadataSource !== "provider") {
      issues.push({ key, reason: "scope" });
      continue;
    }
    if (!field.providerIntegrations?.includes(integration)) {
      issues.push({ key, reason: "integration" });
      continue;
    }
    if (!field.appliesTo.includes(runType)) {
      issues.push({ key, reason: "scope" });
      continue;
    }
    const reason = metadataFieldValueIssue(field, entry);
    if (reason) issues.push({ key, reason });
  }
  return issues;
}

export function normalizeProviderMetadata(
  value: unknown,
  integration: CodingAgentIntegration,
  runType: CodingAgentRunType,
): Record<string, unknown> {
  if (!isPlainRecord(value)) return {};
  const issues = new Map(
    validateProviderMetadata(value, integration, runType).map((issue) => [issue.key, issue]),
  );
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => entry !== undefined && !issues.has(key)),
  );
}
