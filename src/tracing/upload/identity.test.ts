import { Client } from "langsmith";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { sdkSetting } from "../../utils/sdk/normalize.js";
import { UPLOAD_KEY_UNUSABLE_MESSAGE } from "./constants.js";
import { resolveUploadDestinationFingerprint } from "./identity.js";
import { createLangSmithUploadWriter } from "./upload.js";

const clients = vi.hoisted(() => ({
  createUploadClient: vi.fn((options?: { apiKey?: string }) => ({ apiKey: options?.apiKey })),
}));

vi.mock("./client.js", () => ({ createUploadClient: clients.createUploadClient }));

beforeEach(() => clients.createUploadClient.mockClear());

describe("upload destination identity", () => {
  it("treats a quoted empty API key as no key, as the SDK does, so it never falls back to a login", () => {
    const destination = { apiKey: '""', apiUrl: "https://elsewhere.example", projectName: "p" };
    expect(() =>
      createLangSmithUploadWriter({ redact: true, destinations: [destination] }),
    ).toThrow("API key");
  });

  it("refuses an API-key destination when the SDK client ends up with no key", () => {
    clients.createUploadClient.mockImplementationOnce(
      (options) => new Client({ apiKey: sdkSetting(options?.apiKey) ?? "" }) as never,
    );
    const destination = { apiKey: '""""', apiUrl: "https://elsewhere.example", projectName: "p" };
    expect(() =>
      createLangSmithUploadWriter({ redact: true, destinations: [destination] }),
    ).toThrow(UPLOAD_KEY_UNUSABLE_MESSAGE);
  });

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
