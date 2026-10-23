import { Client } from "langsmith";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refusedLoginReplicas } from "../../auth/index.js";
import { sdkSetting } from "../../utils/sdk/normalize.js";
import { UPLOAD_KEY_UNUSABLE_MESSAGE } from "./constants.js";
import { resolveUploadDestinationFingerprint } from "./identity.js";
import { createLangSmithUploadWriter } from "./upload.js";

const clients = vi.hoisted(() => ({
  createUploadClient: vi.fn((options?: { apiKey?: string }) => ({ apiKey: options?.apiKey })),
}));

vi.mock("./client.js", () => ({ createUploadClient: clients.createUploadClient }));

beforeEach(() => clients.createUploadClient.mockClear());

const LOGIN_DESTINATION = {
  login: { configPath: "/synthetic/config.json", profile: "work" },
  apiUrl: "https://login.example",
  projectName: "p",
};

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

  it("keeps an API key's fingerprint from before CLI logins so saved traces still upload", () => {
    const destination = {
      apiKey: "k",
      apiUrl: "https://a.example",
      projectName: "p",
      workspaceId: "w",
    };
    expect(
      resolveUploadDestinationFingerprint({ redact: false, destinations: [destination] }),
    ).toBe("account_2754209f7a9d66ad9aff02e9fd048604");
  });

  it("holds saved traces back when a new login points at another workspace", () => {
    const [first, second] = ["first-workspace", "second-workspace"].map((workspaceId) =>
      resolveUploadDestinationFingerprint({
        redact: true,
        destinations: [
          {
            ...LOGIN_DESTINATION,
            login: { ...LOGIN_DESTINATION.login, workspaceId },
          },
        ],
      }),
    );
    expect(first).not.toBe(second);
  });

  it("uses the login for keyless replicas on its server and refuses others with a reason", () => {
    const replicas = [
      { projectName: "same-server" },
      { apiUrl: "https://login.example/", projectName: "same-url" },
      { apiUrl: "https://other.example" },
    ];
    const writer = createLangSmithUploadWriter({
      redact: true,
      destinations: [LOGIN_DESTINATION],
      replicas,
    });
    const projects = writer.destinations.map(({ id }) => writer.routes[id]!.projectName);
    expect(projects).toEqual(["same-server", "same-url"]);
    expect(refusedLoginReplicas(replicas, "https://login.example")).toMatch(
      /^LangSmith replicas on https:\/\/other\.example need their own API key/,
    );
  });

  it("uploads nothing and says why when every replica is refused for the login", () => {
    const replicas = [{ apiUrl: "https://self-hosted.example", projectName: "team" }];
    expect(() =>
      createLangSmithUploadWriter({ redact: true, destinations: [LOGIN_DESTINATION], replicas }),
    ).toThrow(/^LangSmith replicas on https:\/\/self-hosted\.example need their own API key/);
  });

  it("never hands the login to a replica whose key the SDK reads as empty", () => {
    const replicas = [{ apiKey: '""', apiUrl: "https://elsewhere.example", projectName: "x" }];
    expect(() =>
      createLangSmithUploadWriter({ redact: true, destinations: [LOGIN_DESTINATION], replicas }),
    ).toThrow(/elsewhere\.example need their own API key/);
  });

  it("treats an empty replica key as no key instead of stopping every upload", () => {
    const writer = createLangSmithUploadWriter({
      redact: true,
      destinations: [LOGIN_DESTINATION],
      replicas: [{ apiKey: "", projectName: "empty-key" }],
    });
    expect(writer.routes[writer.destinations[0]!.id]).toMatchObject({ projectName: "empty-key" });
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
