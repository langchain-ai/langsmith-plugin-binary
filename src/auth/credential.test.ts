import { describe, expect, it } from "vitest";
import { writeLoginConfig } from "../test-support/login.js";
import { loginReplicaRefusal, resolveUploadCredential } from "./index.js";

const LOGIN_URL = "https://login.example/api/v1";

function loginEnv(): NodeJS.ProcessEnv {
  const configPath = writeLoginConfig({
    api_url: LOGIN_URL,
    workspace_id: "login-workspace",
    oauth: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" },
  });
  return { LANGSMITH_CONFIG_FILE: configPath };
}

describe("upload credential", () => {
  it("keeps an API key ahead of a valid CLI login so existing users see no change", () => {
    const credential = resolveUploadCredential({
      apiKey: "synthetic-key",
      apiUrl: "https://configured.example",
      env: loginEnv(),
    });
    expect(credential).toEqual({
      kind: "api-key",
      apiKey: "synthetic-key",
      apiUrl: "https://configured.example",
    });
  });

  it("uses the login's own server and workspace when the endpoint is only the default", () => {
    const env = loginEnv();
    const credential = resolveUploadCredential({
      apiUrl: "https://api.smith.langchain.com",
      apiUrlIsDefault: true,
      env,
    });
    expect(credential).toEqual({
      kind: "login",
      apiUrl: LOGIN_URL,
      login: {
        configPath: env["LANGSMITH_CONFIG_FILE"],
        profile: "work",
        workspaceId: "login-workspace",
      },
    });
  });

  it("refuses the login for a configured endpoint on another server and says why", () => {
    const credential = resolveUploadCredential({
      apiUrl: "https://other.example",
      env: loginEnv(),
    });
    expect(credential.kind).toBe("none");
    expect(credential).toMatchObject({
      reason: expect.stringContaining(`login is for ${LOGIN_URL} but tracing sends to`),
    });
    expect(credential).not.toMatchObject({ reason: expect.stringContaining("--api-url") });
    expect(
      resolveUploadCredential({ apiUrl: "https://login.example/", env: loginEnv() }).kind,
    ).toBe("login");
  });

  it("treats case, default ports and spaces in the endpoint as the login's own server", () => {
    const apiUrl = "  https://LOGIN.example:443/api/v1/ ";
    expect(resolveUploadCredential({ apiUrl, env: loginEnv() }).kind).toBe("login");
  });

  it("reports no credential when there is no login or an environment key would hide it", () => {
    expect(resolveUploadCredential({ env: { HOME: "/nonexistent-home" } })).toEqual({
      kind: "none",
      reason: [
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "⚠️  LANGSMITH TRACING IS PAUSED",
        "You're not signed in to LangSmith so this session isn't being traced.",
        "▶ Run the following command: langsmith auth login",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
      ].join("\n"),
    });
    expect(
      resolveUploadCredential({ env: { ...loginEnv(), LANGCHAIN_API_KEY: "synthetic-env-key" } }),
    ).toMatchObject({
      kind: "none",
      reason: expect.stringContaining("LANGCHAIN_API_KEY is overriding"),
    });
    expect(resolveUploadCredential({ env: { ...loginEnv(), LANGSMITH_API_KEY: '""' } }).kind).toBe(
      "login",
    );
  });

  it("picks the same profile the SDK does, so it never uploads without auth", () => {
    const env = { ...loginEnv(), LANGSMITH_PROFILE: " work" };
    expect(resolveUploadCredential({ env }).kind).toBe("none");
  });

  it("says why only when every configured replica is refused for the login", () => {
    const elsewhere = { apiUrl: "https://self-hosted.example" };
    expect(loginReplicaRefusal([elsewhere], LOGIN_URL)).toContain("self-hosted.example");
    expect(
      loginReplicaRefusal([elsewhere, { ...elsewhere, apiKey: "k" }], LOGIN_URL),
    ).toBeUndefined();
    expect(loginReplicaRefusal([], LOGIN_URL)).toBeUndefined();
  });

  it("reads keys, endpoints and replicas the way the SDK does, quotes and all", () => {
    expect(resolveUploadCredential({ apiKey: '""', env: loginEnv() }).kind).toBe("login");
    expect(resolveUploadCredential({ apiUrl: `"${LOGIN_URL}"`, env: loginEnv() }).kind).toBe(
      "login",
    );
    const quoted = [{ apiKey: "''", apiUrl: "https://self-hosted.example" }];
    expect(loginReplicaRefusal(quoted, LOGIN_URL)).toContain("self-hosted.example");
  });
});
