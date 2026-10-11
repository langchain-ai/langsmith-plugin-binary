import { describe, expect, it } from "vitest";

import { resolveUploadDestinationFingerprint } from "./identity.js";

describe("upload destination identity", () => {
  it("derives a stable account fingerprint from the bound destination identity", () => {
    const options = {
      destinations: [
        {
          apiKey: "synthetic-primary-key",
          apiUrl: "http://127.0.0.1:4318/",
          projectName: "primary-project",
          workspaceId: "primary-workspace",
        },
      ],
      replicas: [
        {
          apiKey: "synthetic-replica-key",
          projectName: "replica-project",
          updates: { extra: { metadata: { owner: "synthetic" } } },
        },
      ],
      redact: true,
      redactExtraRules: [{ pattern: "synthetic-private-marker", replace: "[removed]" }],
    };

    const fingerprint = resolveUploadDestinationFingerprint(options);

    expect(fingerprint).toMatch(/^account_[0-9a-f]{32}$/);
    expect(resolveUploadDestinationFingerprint(options)).toBe(fingerprint);
  });
});
