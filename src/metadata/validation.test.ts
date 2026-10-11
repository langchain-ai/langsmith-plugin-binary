import { describe, expect, it } from "vitest";
import { normalizeProviderMetadata, validateProviderMetadata } from "./index.js";
import type { CodingAgentRunType } from "./index.js";

describe("coding-agent-v1 metadata contract", () => {
  it("rejects scoped provider metadata when its runtime run type is missing", () => {
    const providerMetadata = { ls_provider: "openai" };
    const missingRunType = undefined as unknown as CodingAgentRunType;
    expect(validateProviderMetadata(providerMetadata, "openai-codex", missingRunType)).toEqual([
      { key: "ls_provider", reason: "scope" },
    ]);
    expect(normalizeProviderMetadata(providerMetadata, "openai-codex", missingRunType)).toEqual({});
  });
});
