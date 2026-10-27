import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { writeLoginConfig } from "../test-support/login.js";
import { loginCommand, loginReplicaRefusal, resolveUploadCredential } from "./index.js";

const LOGIN_URL = "https://login.example/api/v1";
const CONFIGURED_WORKSPACE = "0f6aa4d5-4686-425f-bc12-288b4079e73e";

function loginEnv(): NodeJS.ProcessEnv {
  const configPath = writeLoginConfig({
    api_url: LOGIN_URL,
    workspace_id: "login-workspace",
    oauth: { access_token: "synthetic-access", refresh_token: "synthetic-refresh" },
  });
  return { LANGSMITH_CONFIG_FILE: configPath };
}

function hint(profile: string) {
  return resolveUploadCredential({ profile, env: loginEnv() });
}

describe("upload credential", () => {
  it("keeps a plugin API key ahead of a valid CLI login on the same server", () => {
    const credential = resolveUploadCredential({
      apiKey: "synthetic-key",
      apiUrl: LOGIN_URL,
      env: { ...loginEnv(), LANGSMITH_API_KEY: "synthetic-env-key" },
    });
    expect(credential).toEqual({
      kind: "api-key",
      apiKey: "synthetic-key",
      apiUrl: LOGIN_URL,
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

  it("reports no credential when there is neither a login nor an API key", () => {
    expect(resolveUploadCredential({ env: { HOME: "/nonexistent-home" } })).toEqual({
      kind: "none",
      reason: [
        "⚠️ LANGSMITH TRACING IS PAUSED ⚠️",
        "You're not signed in to LangSmith so this session isn't being traced.",
        "▶ Run the following command: langsmith auth login",
      ].join("\n"),
    });
  });

  it("uses the login over a generic environment key so only a plugin key beats it", () => {
    const env = { ...loginEnv(), LANGCHAIN_API_KEY: "synthetic-env-key" };
    expect(resolveUploadCredential({ env }).kind).toBe("login");
  });

  it("falls back to a generic environment key when there's no usable login", () => {
    const env = { HOME: "/nonexistent-home", LANGSMITH_API_KEY: "synthetic-env-key" };
    expect(resolveUploadCredential({ env })).toEqual({
      kind: "api-key",
      apiKey: "synthetic-env-key",
      apiUrl: "https://api.smith.langchain.com",
    });
    const elsewhere = { ...loginEnv(), LANGCHAIN_API_KEY: "synthetic-env-key" };
    expect(resolveUploadCredential({ apiUrl: "https://other.example", env: elsewhere })).toEqual({
      kind: "api-key",
      apiKey: "synthetic-env-key",
      apiUrl: "https://other.example",
    });
    expect(resolveUploadCredential({ env: { ...loginEnv(), LANGSMITH_API_KEY: '""' } }).kind).toBe(
      "login",
    );
  });

  it("picks the same profile the SDK does, so it never uploads without auth", () => {
    const env = { ...loginEnv(), LANGSMITH_PROFILE: " work" };
    expect(resolveUploadCredential({ env }).kind).toBe("none");
  });

  it("uses the configured profile over LANGSMITH_PROFILE and the CLI's current one", () => {
    const configPath = loginEnv()["LANGSMITH_CONFIG_FILE"]!;
    const env = { LANGSMITH_CONFIG_FILE: configPath, LANGSMITH_PROFILE: "work" };
    const work = { api_url: LOGIN_URL, oauth: { refresh_token: "w" } };
    const company = { api_url: "https://company.example", oauth: { refresh_token: "r" } };
    const profiles = { work, company };
    writeFileSync(configPath, JSON.stringify({ current_profile: "work", profiles }));
    expect(resolveUploadCredential({ profile: "company", env })).toEqual({
      kind: "login",
      apiUrl: "https://company.example",
      login: { configPath, profile: "company" },
    });
  });

  it("sends a configured workspace with a login but leaves API keys alone", () => {
    const login = resolveUploadCredential({ workspaceId: CONFIGURED_WORKSPACE, env: loginEnv() });
    expect(login).toMatchObject({ login: { workspaceId: CONFIGURED_WORKSPACE } });
    const env = { ...loginEnv(), LANGSMITH_WORKSPACE_ID: "from-env" };
    expect(resolveUploadCredential({ env })).toMatchObject({ login: { workspaceId: "from-env" } });
    expect(resolveUploadCredential({ workspaceId: CONFIGURED_WORKSPACE, env })).toMatchObject({
      login: { workspaceId: CONFIGURED_WORKSPACE },
    });
    const key = resolveUploadCredential({
      apiKey: "k",
      workspaceId: CONFIGURED_WORKSPACE,
      env: {},
    });
    expect(key).not.toHaveProperty("workspaceId");
  });

  it("pauses with a reason instead of sending an agent_id the server would reject", () => {
    for (const agentId of ["Support Agent", "-support", "support-", "a".repeat(64)])
      expect(resolveUploadCredential({ agentId, apiKey: "k" })).toMatchObject({
        kind: "none",
        reason: expect.stringContaining("isn't an agent ID"),
      });
    for (const agentId of ["support-agent", "a", "a".repeat(63)])
      expect(resolveUploadCredential({ agentId, apiKey: "k" }).kind).toBe("api-key");
  });

  it("pauses with a reason instead of sending a workspace_id that isn't a workspace ID", () => {
    expect(resolveUploadCredential({ workspaceId: "my-team", env: loginEnv() })).toMatchObject({
      kind: "none",
      reason: expect.stringContaining('workspace_id setting "my-team" isn\'t a workspace ID'),
    });
  });

  it("says to sign in rather than falling back to an environment key when the profile is missing", () => {
    const env = { ...loginEnv(), LANGCHAIN_API_KEY: "synthetic-env-key" };
    expect(resolveUploadCredential({ profile: "ghost", env })).toMatchObject({
      kind: "none",
      reason: expect.stringMatching(/--profile ghost$/u),
    });
  });

  it("double-quotes a profile name on Windows, where single quotes don't quote", () => {
    expect(loginCommand("my team", "win32")).toBe('langsmith auth login --profile "my team"');
    expect(loginCommand("my team", "darwin")).toBe("langsmith auth login --profile 'my team'");
    expect(loginCommand("it's $HOME", "darwin")).toBe(
      "langsmith auth login --profile 'it'\\''s $HOME'",
    );
  });

  it("names LANGSMITH_PROFILE in the sign-in command when that profile isn't signed in", () => {
    const env = { ...loginEnv(), LANGSMITH_PROFILE: "staging" };
    expect(resolveUploadCredential({ env })).toMatchObject({
      reason: expect.stringMatching(/: langsmith auth login --profile staging$/u),
    });
  });

  it("names the configured profile in the sign-in command when it isn't signed in", () => {
    expect(hint("company")).toMatchObject({
      kind: "none",
      reason: expect.stringMatching(/: langsmith auth login --profile company$/u),
    });
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
