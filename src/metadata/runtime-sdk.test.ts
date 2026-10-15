import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, expect, it, vi } from "vitest";
import { __version__ } from "langsmith";
import { CODING_AGENT_V1_CONTRACT } from "./contract.js";
import { buildCodingAgentRuntimeMetadata } from "./runtime.js";

const NEWER_SDK_EXCLUSIONS = ["LANGSMITH_AGENT_ID", "LANGSMITH_AGENT_ENVIRONMENT"];
const ENDPOINT_NAMES = [
  "LANGSMITH_RUNS_ENDPOINTS",
  "LANGSMITH_PROXY",
  "LANGSMITH_CUSTOM_ENDPOINT_X",
  "LANGCHAIN_CALLBACK_URL",
  "LANGSMITH_AUTH_MODE",
  "LANGCHAIN_EXTRA_HEADERS",
  "LANGSMITH_HTTPS_PROXY",
];
const sdkEnvironmentPath = join(
  dirname(createRequire(import.meta.url).resolve("langsmith")),
  "lib",
  "utils",
  "env.mjs",
);
const sdkSource = readFileSync(sdkEnvironmentPath, "utf8");
const { runtime: contract } = CODING_AGENT_V1_CONTRACT;
let sdk: {
  getEnv(): string;
  getRuntimeEnvironment(): Record<string, string>;
  getLangSmithEnvVarsMetadata(): Record<string, string>;
};

function sdkList(marker: string): string[] {
  const start = sdkSource.indexOf(marker);
  if (start === -1) throw new Error(`The SDK no longer declares ${marker}`);
  const list = sdkSource.slice(start, sdkSource.indexOf("]", start));
  return [...list.matchAll(/"([^"]+)"/gu)].map(([, value]) => value!);
}

beforeAll(async () => {
  for (const [index, name] of contract.releaseEnvironmentVariables.entries())
    vi.stubEnv(name, `release-${index}`);
  for (const name of [...contract.environmentMetadata.excluded, ...NEWER_SDK_EXCLUSIONS])
    vi.stubEnv(name, "excluded");
  for (const name of ENDPOINT_NAMES) vi.stubEnv(name, "http://user:pass@127.0.0.1:1");
  for (const part of contract.environmentMetadata.sensitiveSubstrings) {
    vi.stubEnv(`LANGSMITH_${part}_X`, "lower");
    vi.stubEnv(`LANGCHAIN_X_${part.toUpperCase()}`, "upper");
  }
  for (const name of [
    "LANGSMITH_PLAIN",
    "LANGCHAIN_PLAIN",
    "LANGSMITH_Mixed_Case",
    "LANGCHAIN_REVISION_ID",
    "LANGSMITHNOUNDERSCORE",
    "OTHER_LANGSMITH_VAR",
    "LANGSMITH_",
  ])
    vi.stubEnv(name, `value-${name}`);
  sdk = (await import(pathToFileURL(sdkEnvironmentPath).href)) as typeof sdk;
});

it("lists the same release variables, exclusions and secret markers as the installed SDK", () => {
  expect(contract.releaseEnvironmentVariables).toEqual(sdkList("const common_release_envs"));
  expect(contract.environmentMetadata.sensitiveSubstrings).toEqual(
    sdkList("const EXCLUDED_SUBSTRINGS"),
  );
  const sdkExcluded = sdkList("const excluded");
  expect(
    sdkExcluded.filter((name) => !contract.environmentMetadata.excluded.includes(name)),
  ).toEqual([]);
  expect(
    contract.environmentMetadata.excluded.filter((name) => !sdkExcluded.includes(name)),
  ).toSatisfy((names: string[]) => names.every((name) => NEWER_SDK_EXCLUSIONS.includes(name)));
});

it("produces the runtime fields and environment metadata the installed SDK adds", () => {
  const ours = buildCodingAgentRuntimeMetadata({
    env: process.env,
    runtime: sdk.getEnv(),
    sdkVersion: __version__,
  });
  expect(ours.runtime).toEqual(sdk.getRuntimeEnvironment());
  const sdkMetadata = sdk.getLangSmithEnvVarsMetadata();
  expect(Object.keys(ours.metadata).length).toBeGreaterThan(4);
  for (const [key, value] of Object.entries(ours.metadata)) expect(sdkMetadata[key]).toBe(value);
  expect(
    Object.keys(sdkMetadata)
      .filter((key) => !(key in ours.metadata))
      .toSorted(),
  ).toEqual(
    [...NEWER_SDK_EXCLUSIONS, ...ENDPOINT_NAMES].filter((key) => key in sdkMetadata).toSorted(),
  );
  for (const name of ENDPOINT_NAMES) expect(ours.metadata).not.toHaveProperty(name);
});
