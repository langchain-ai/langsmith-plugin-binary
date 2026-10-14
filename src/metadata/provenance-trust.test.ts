import { describe, expect, it } from "vitest";
import { buildCodingAgentMetadata, metadataForMode } from "./index.js";
import { trustedCodingAgentMetadata } from "./builder.js";

const MUTED = { status: "running", ls_tracing_mode: "metadata" };

function codexMetadata(base: Record<string, unknown>, usage?: Record<string, unknown>) {
  return buildCodingAgentMetadata({
    integration: "openai-codex",
    threadId: "thread",
    agentType: "root",
    runType: "root",
    base,
    ...(usage === undefined ? {} : { usageMetadata: usage }),
  });
}

describe("trusted metadata provenance", () => {
  it("keeps provenance non-enumerable and lost by copies and serialization", () => {
    const metadata = codexMetadata({ custom: "private" });
    const symbols = Object.getOwnPropertySymbols(metadata);
    expect(symbols).toHaveLength(1);
    expect(Object.getOwnPropertyDescriptor(metadata, symbols[0]!)?.enumerable).toBe(false);
    expect(Object.keys(metadata)).toContain("custom");
    expect(trustedCodingAgentMetadata(metadata)).toMatchObject({ thread_id: "thread" });
    expect(trustedCodingAgentMetadata(metadata)).not.toHaveProperty("custom");
    expect(trustedCodingAgentMetadata({ ...metadata })).toBeUndefined();
    expect(trustedCodingAgentMetadata(JSON.parse(JSON.stringify(metadata)))).toBeUndefined();
    expect(trustedCodingAgentMetadata(undefined)).toBeUndefined();
  });

  it("does not trust custom collisions or later changes to the merged object", () => {
    const metadata = codexMetadata({ ls_model_name: "private", cwd: "PRIVATE_CWD" });
    metadata.thread_id = "private";
    const projected = metadataForMode(metadata, "openai-codex", "metadata");
    expect(projected).toMatchObject({ thread_id: "thread", ...MUTED });
    expect(JSON.stringify(projected)).not.toMatch(/private/i);
    const copied = metadataForMode({ ...metadata }, "openai-codex", "metadata");
    expect(copied).toEqual(MUTED);
    expect(metadataForMode(metadata, "openai-codex", "full")).toBe(metadata);
  });

  it("keeps the trusted usage object and ignores a custom one with the same key", () => {
    const usage = { input_tokens: 2, costs: { input: 0.25, currency: "USD" } };
    const metadata = codexMetadata({ usage_metadata: { annotation: "PRIVATE_COLLISION" } }, usage);
    const projected = metadataForMode(metadata, "openai-codex", "metadata");
    expect(projected).toMatchObject(MUTED);
    expect(projected?.usage_metadata).toBe(usage);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_COLLISION");
    expect(metadataForMode({ usage_metadata: usage }, "openai-codex", "metadata")).toEqual(MUTED);
  });
});
