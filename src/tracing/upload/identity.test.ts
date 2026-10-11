import { beforeEach, describe, expect, it, vi } from "vitest";

const clients = vi.hoisted(() => ({ createUploadClient: vi.fn(() => ({})) }));

vi.mock("./client.js", () => ({ createUploadClient: clients.createUploadClient }));

import { resolveUploadDestinationFingerprint } from "./identity.js";
import { createLangSmithUploadWriter } from "./upload.js";

beforeEach(() => clients.createUploadClient.mockClear());

describe("upload destination identity", () => {
  it("derives the writer fingerprint without creating upload clients", () => {
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
    expect(clients.createUploadClient).not.toHaveBeenCalled();
    expect(createLangSmithUploadWriter(options).accountFingerprint).toBe(fingerprint);
    expect(clients.createUploadClient).toHaveBeenCalledTimes(1);
  });
});
