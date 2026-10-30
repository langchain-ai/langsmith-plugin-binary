import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  COMMON_CONFIG_FILE_NAME,
  COMMON_CONFIG_OPEN_FLAGS,
  SETUP_API_KEY_GIVEN,
  SETUP_API_KEY_PATTERN,
  SETUP_ARGUMENT_SEPARATOR,
  SETUP_DESTINATION,
  SETUP_AGENT_DESTINATION,
  SETUP_DESTINATION_FIELDS,
  SETUP_DIRECTORY_MODE,
  SETUP_ENABLED,
  SETUP_FILE_FAILED,
  SETUP_FILE_FAILED_FIELDS,
  SETUP_FILE_MODE,
  SETUP_INVALID_CONFIG,
  SETUP_INVALID_URL,
  SETUP_LINE_BREAK,
  SETUP_MULTIPLE_LINES,
  SETUP_MUTED,
  SETUP_NO_CREDENTIAL,
  SETUP_OVERRIDDEN,
  SETUP_REPLICA_DESTINATION,
  SETUP_PROJECT_QUOTES,
  SETUP_SIGN_IN,
  SETUP_STILL_OFF,
  SETUP_TEMP_SUFFIX,
  SETUP_TOO_MANY_URLS,
  SETUP_UNREADABLE_CONFIG,
  SETUP_URL_PATTERN,
  SETUP_URL_WITH_CREDENTIALS,
  SETUP_URL_WITH_QUERY,
  UTF8_BOM,
} from "./constants.js";
import type { SetupOutcome, SetupRequest } from "./models.js";
import { parseCommonConfig } from "./parse.js";
import { object } from "./utils/records.js";

export function parseSetupArguments(text: string): SetupRequest {
  if (SETUP_LINE_BREAK.test(text.trimEnd())) throw new Error(SETUP_MULTIPLE_LINES);
  if (SETUP_API_KEY_PATTERN.test(text)) throw new Error(SETUP_API_KEY_GIVEN);
  const words = text.trim().split(SETUP_ARGUMENT_SEPARATOR).filter(Boolean);
  const urls = words.filter((word) => SETUP_URL_PATTERN.test(word));
  if (urls.length > 1) throw new Error(SETUP_TOO_MANY_URLS);
  const apiUrl = urls[0];
  if (apiUrl !== undefined && !URL.canParse(apiUrl)) {
    throw new Error(SETUP_INVALID_URL.replace("{url}", () => apiUrl));
  }
  if (apiUrl !== undefined) {
    const { username, password, search, hash } = new URL(apiUrl);
    if (username || password) throw new Error(SETUP_URL_WITH_CREDENTIALS);
    if (search || hash) throw new Error(SETUP_URL_WITH_QUERY);
  }
  const project = words
    .filter((word) => word !== apiUrl)
    .join(" ")
    .replace(SETUP_PROJECT_QUOTES, "$2")
    .trim();
  return {
    ...(project ? { project } : {}),
    ...(apiUrl === undefined ? {} : { apiUrl }),
  };
}

function readExisting(path: string): unknown {
  let fd: number;
  try {
    fd = openSync(path, COMMON_CONFIG_OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return JSON.parse(readFileSync(fd, "utf8").replace(UTF8_BOM, ""));
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function resolveTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return path;
  }
}

function failure(path: string, error: unknown): Error {
  const reason = (error as NodeJS.ErrnoException).code ?? String(error);
  return new Error(
    SETUP_FILE_FAILED.replace(SETUP_FILE_FAILED_FIELDS, (_match, field: string) =>
      field === "path" ? path : reason,
    ),
  );
}

function writeAtomically(target: string, contents: string): void {
  mkdirSync(dirname(target), { recursive: true, mode: SETUP_DIRECTORY_MODE });
  const temp = `${target}.${randomUUID()}${SETUP_TEMP_SUFFIX}`;
  const fd = openSync(temp, "wx", SETUP_FILE_MODE);
  try {
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function writeSetupConfig(
  home: string,
  harnessDirectory: string,
  request: SetupRequest,
): string {
  const path = join(home, harnessDirectory, COMMON_CONFIG_FILE_NAME);
  let target: string;
  let existing: unknown;
  try {
    target = resolveTarget(path);
    existing = readExisting(target);
  } catch (error) {
    throw failure(path, error);
  }
  if (!object(existing)) throw new Error(SETUP_UNREADABLE_CONFIG.replace("{path}", () => path));
  const updated = {
    ...existing,
    enabled: true,
    ...(request.project === undefined ? {} : { project: request.project }),
    ...(request.apiUrl === undefined ? {} : { api_url: request.apiUrl }),
  };
  if (parseCommonConfig(updated).status !== "valid") {
    throw new Error(SETUP_INVALID_CONFIG.replace("{path}", () => path));
  }
  try {
    writeAtomically(target, `${JSON.stringify(updated, null, 2)}\n`);
  } catch (error) {
    throw failure(path, error);
  }
  return path;
}

function describeDestination(outcome: SetupOutcome): string {
  if (outcome.replicaCount !== undefined && outcome.replicaCount > 0) {
    const template =
      outcome.replicaCount === 1 ? SETUP_REPLICA_DESTINATION.one : SETUP_REPLICA_DESTINATION.many;
    return template.replace("{replicaCount}", () => String(outcome.replicaCount));
  }
  const template = outcome.agentId === undefined ? SETUP_DESTINATION : SETUP_AGENT_DESTINATION;
  return template.replace(
    SETUP_DESTINATION_FIELDS,
    (_match, field: "project" | "agentId" | "apiUrl") => JSON.stringify(outcome[field]),
  );
}

export function describeSetup(outcome: SetupOutcome): string {
  const { requested } = outcome;
  const overridden =
    (requested.project !== undefined &&
      (outcome.agentId !== undefined || requested.project !== outcome.project)) ||
    ((requested.project !== undefined || requested.apiUrl !== undefined) &&
      outcome.replicaCount !== undefined &&
      outcome.replicaCount > 0) ||
    (requested.apiUrl !== undefined && requested.apiUrl !== outcome.apiUrl);
  return [
    SETUP_ENABLED.replace("{path}", () => outcome.path),
    describeDestination(outcome),
    ...(outcome.enabled ? [] : [SETUP_STILL_OFF]),
    ...(overridden ? [SETUP_OVERRIDDEN] : []),
    ...(outcome.muted ? [SETUP_MUTED] : []),
    outcome.credentialProblem ??
      (outcome.signIn === "none" ? SETUP_NO_CREDENTIAL : SETUP_SIGN_IN[outcome.signIn]),
  ].join(" ");
}
