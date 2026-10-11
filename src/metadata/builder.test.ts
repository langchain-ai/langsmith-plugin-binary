import { describe, expect, it } from "vitest";
import {
  buildCodingAgentMetadata,
  normalizeProviderMetadata,
  validateCodingAgentMetadata,
  validateProviderMetadata,
} from "./index.js";

describe("coding-agent-v1 metadata construction", () => {
  it("keeps integration identity and versions explicit", () => {
    const metadata = buildCodingAgentMetadata({
      integration: "claude-code",
      integrationVersion: "0.1.3",
      runtimeVersion: "2.1.181",
      threadId: "session",
      turnId: "turn",
      turnNumber: 3,
      agentType: "root",
      runType: "root",
    });
    expect(metadata).toMatchObject({
      ls_integration: "claude-code",
      ls_agent_runtime: "Claude Code",
      ls_integration_version: "0.1.3",
      ls_agent_runtime_version: "2.1.181",
      ls_trace_schema_version: "coding-agent-v1",
      thread_id: "session",
      turn_id: "turn",
      turn_number: 3,
    });
    expect(metadata.ls_integration_version).not.toBe(metadata.ls_agent_runtime_version);
  });

  it("validates and filters provider metadata from the shared contract", () => {
    const candidate = {
      ls_provider: "openai",
      ls_model_type: 7,
      ls_message_format: "anthropic",
      thread_id: "spoofed",
    };
    expect(validateProviderMetadata(candidate, "openai-codex", "llm")).toEqual([
      { key: "ls_model_type", reason: "type" },
      { key: "thread_id", reason: "scope" },
    ]);
    const rootOnlyUsage = { ls_raw_aggregated_usage: { input_tokens: 1 } };
    expect(validateProviderMetadata(rootOnlyUsage, "openai-codex", "llm")).toEqual([
      { key: "ls_raw_aggregated_usage", reason: "scope" },
    ]);
    expect(normalizeProviderMetadata(rootOnlyUsage, "openai-codex", "llm")).toEqual({});
    expect(
      buildCodingAgentMetadata({
        integration: "openai-codex",
        threadId: "session",
        agentType: "root",
        runType: "llm",
        providerMetadata: candidate,
      }),
    ).toMatchObject({ ls_provider: "openai", ls_message_format: "anthropic" });
    expect(
      buildCodingAgentMetadata({
        integration: "cursor",
        threadId: "session",
        agentType: "root",
        runType: "root",
        providerMetadata: { ls_model_type: "chat" },
      }),
    ).not.toHaveProperty("ls_model_type");
  });

  it("rejects metadata with missing identity, wrong scope, or wrong field types", () => {
    const valid = buildCodingAgentMetadata({
      integration: "cursor",
      threadId: "session",
      agentType: "root",
      runType: "root",
    });
    expect(validateCodingAgentMetadata(valid, "root", "cursor")).toEqual([]);
    expect(
      validateCodingAgentMetadata(
        { ...valid, ls_attribution_identifier: "person@example.com" },
        "root",
        "cursor",
      ),
    ).toEqual([]);
    expect(
      validateCodingAgentMetadata(
        { ...valid, thread_id: undefined, turn_number: "3", ls_tool_name: "Bash" },
        "root",
        "cursor",
      ),
    ).toEqual([
      { key: "thread_id", reason: "missing" },
      { key: "turn_number", reason: "type" },
      { key: "ls_tool_name", reason: "scope" },
    ]);
  });
});
