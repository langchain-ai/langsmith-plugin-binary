import { describe, expect, it } from "vitest";
import {
  buildCodingAgentMetadata,
  metadataForMode,
  normalizeProviderMetadata,
  validateCodingAgentMetadata,
  validateProviderMetadata,
} from "./index.js";
import type { CodingAgentRunType } from "./index.js";

describe("coding-agent-v1 metadata contract", () => {
  it.each(["subagent", "interrupted"] as const)(
    "preserves Codex aggregate usage on %s runs",
    (runType) => {
      const aggregate = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
      const metadata = buildCodingAgentMetadata({
        integration: "openai-codex",
        threadId: "session",
        agentType: runType === "subagent" ? "subagent" : "root",
        runType,
        providerMetadata: { ls_raw_aggregated_usage: aggregate },
      });
      expect(metadata.ls_raw_aggregated_usage).toEqual(aggregate);
      expect(metadataForMode(metadata, "openai-codex", "metadata")).toMatchObject({
        ls_raw_aggregated_usage: aggregate,
      });
    },
  );

  it("preserves Cursor's native tool name in muted metadata when it matches the run name", () => {
    const metadata = buildCodingAgentMetadata({
      integration: "cursor",
      threadId: "session",
      agentType: "root",
      runType: "tool",
      toolName: "ReadFile",
      runName: "ReadFile",
    });
    expect(metadata).not.toHaveProperty("ls_tool_name");
    expect(metadataForMode(metadata, "cursor", "metadata")).toMatchObject({
      ls_tool_name: "ReadFile",
    });
  });

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

  it.each(["claude-code", "cursor"] as const)(
    "preserves %s custom-base precedence from the current adapters",
    (integration) => {
      const metadata = buildCodingAgentMetadata({
        integration,
        threadId: "session",
        agentType: "root",
        runType: "root",
        base: { thread_id: "custom-thread", custom_field: "kept" },
        runSpecific: { ls_model_name: "custom-model" },
        modelName: "builder-model",
      });
      expect(metadata).toMatchObject({
        thread_id: "custom-thread",
        ls_model_name: "custom-model",
        custom_field: "kept",
      });
      expect(metadataForMode(metadata, integration, "metadata")).toMatchObject({
        thread_id: "session",
        ls_model_name: "builder-model",
      });
    },
  );

  it("keeps Codex structural and provider fields ahead of custom metadata", () => {
    const metadata = buildCodingAgentMetadata({
      integration: "openai-codex",
      threadId: "session",
      agentType: "root",
      runType: "llm",
      base: { thread_id: "custom-thread", ls_provider: "custom-provider", private: "full-only" },
      runSpecific: { ls_model_type: "custom-type" },
      providerMetadata: { ls_provider: "openai", ls_model_type: "chat" },
    });
    expect(metadata).toMatchObject({
      thread_id: "session",
      ls_provider: "openai",
      ls_model_type: "chat",
      private: "full-only",
    });
    expect(metadataForMode(metadata, "openai-codex", "metadata")).toMatchObject({
      thread_id: "session",
      ls_provider: "openai",
      ls_model_type: "chat",
    });
    expect(metadataForMode(metadata, "openai-codex", "metadata")).not.toHaveProperty("private");
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

  it("rejects scoped provider metadata when its runtime run type is missing", () => {
    const providerMetadata = { ls_provider: "openai" };
    const missingRunType = undefined as unknown as CodingAgentRunType;
    expect(validateProviderMetadata(providerMetadata, "openai-codex", missingRunType)).toEqual([
      { key: "ls_provider", reason: "scope" },
    ]);
    expect(normalizeProviderMetadata(providerMetadata, "openai-codex", missingRunType)).toEqual({});
  });

  it("keeps the complete trusted Codex usage objects in metadata mode", () => {
    const usage = {
      input_tokens: 2,
      output_tokens: 3,
      custom: { annotation: "kept" },
    };
    const aggregate = { total_token_usage: { input_tokens: 5, output_tokens: 7 } };
    const metadata = buildCodingAgentMetadata({
      integration: "openai-codex",
      integrationVersion: "1.4.0",
      runtimeVersion: "0.123.0",
      threadId: "session",
      agentType: "root",
      runType: "root",
      providerMetadata: {
        codex_cli_version: "0.123.0",
        ls_message_format: "anthropic",
        ls_raw_aggregated_usage: aggregate,
      },
      usageMetadata: usage,
      base: { usage_metadata: { input_tokens: 999 }, custom: "filtered" },
    });
    const safe = metadataForMode(metadata, "openai-codex", "metadata");
    expect(safe?.usage_metadata).toBe(usage);
    expect(safe?.ls_raw_aggregated_usage).toBe(aggregate);
    expect(safe).toMatchObject({
      codex_cli_version: "0.123.0",
      ls_message_format: "anthropic",
      ls_agent_runtime_version: "0.123.0",
      ls_integration_version: "1.4.0",
    });
    expect(safe).not.toHaveProperty("custom");
  });

  it("uses direct metadata only for integrations whose compatibility policy allows it", () => {
    expect(
      metadataForMode(
        {
          thread_id: "direct",
          cwd: "/private/path",
          ls_attribution_identifier: "person@example.com",
        },
        "cursor",
        "metadata",
      ),
    ).toMatchObject({ thread_id: "direct", ls_tracing_mode: "metadata" });
    expect(
      metadataForMode(
        { thread_id: "direct", ls_attribution_identifier: "person@example.com" },
        "cursor",
        "metadata",
      ),
    ).not.toHaveProperty("ls_attribution_identifier");
    expect(
      metadataForMode({ thread_id: "direct", cwd: "/private/path" }, "openai-codex", "metadata"),
    ).toEqual({ status: "running", ls_tracing_mode: "metadata" });
  });

  it("preserves anonymized contract strings during metadata projection", () => {
    const redacted = {
      ls_agent_purpose: "[redacted]",
      ls_integration: "[redacted]",
      ls_agent_runtime: "[redacted]",
      ls_trace_schema_version: "[redacted]",
      ls_agent_type: "[redacted]",
      thread_id: "session",
    };
    expect(metadataForMode(redacted, "claude-code", "metadata")).toMatchObject(redacted);
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
