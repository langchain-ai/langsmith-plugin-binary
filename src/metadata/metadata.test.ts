import { describe, expect, it } from "vitest";
import { buildCodingAgentMetadata, metadataForMode } from "./index.js";

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
});
