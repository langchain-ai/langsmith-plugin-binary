import { createHash } from "node:crypto";
import { Client } from "langsmith";
import { canonicalJsonObject } from "../../utils/validation/objects.js";
import {
  UPLOAD_ACCOUNT_FINGERPRINT_PREFIX,
  UPLOAD_API_URL_TRAILING_SLASH_PATTERN,
  UPLOAD_CONTROL_CHARACTER_PATTERN,
  UPLOAD_DESTINATION_ID_PREFIX,
  UPLOAD_FINGERPRINT_LENGTH,
  UPLOAD_REPLICA_IDENTITY_UPDATE_FIELDS,
  UPLOAD_REPLICA_PATCH_UPDATE_FIELDS,
} from "./constants.js";
import type {
  LangSmithUploadDestinationConfig,
  LangSmithUploadReplicaConfig,
  LangSmithUploadWriterOptions,
  ResolvedUploadDestination,
  ResolvedUploadDestinations,
} from "./models.js";
import { createUploadAnonymizer } from "./redaction.js";

export function resolveUploadDestinations(
  options: LangSmithUploadWriterOptions,
): ResolvedUploadDestinations {
  if (!Array.isArray(options.destinations) || options.destinations.length === 0) {
    throw new TypeError("At least one upload destination is required");
  }
  if (options.replicas !== undefined && !Array.isArray(options.replicas)) {
    throw new TypeError("Upload replicas must be an array");
  }
  if (typeof options.redact !== "boolean") throw new TypeError("A redaction setting is required");
  const replicas = options.replicas ?? [];
  if (replicas.length > 0 && options.destinations.length !== 1) {
    throw new TypeError("A replica upload requires exactly one primary destination");
  }
  const primary = options.destinations[0];
  const primaryProjectName =
    replicas.length === 0 || primary === undefined
      ? undefined
      : normalizeRequiredText(primary.projectName, "project name");
  const destinations =
    replicas.length === 0
      ? options.destinations.map((destination) => resolveDestination(destination, options))
      : replicas.map((replica) =>
          resolveReplicaDestination(replica, primary!, primaryProjectName!, options),
        );
  const ids = new Set<string>();
  for (const destination of destinations) {
    if (ids.has(destination.id)) throw new TypeError("Upload destinations must be unique");
    ids.add(destination.id);
  }
  const fingerprints = destinations.map(({ id }) => id).toSorted();
  const accountFingerprint = `${UPLOAD_ACCOUNT_FINGERPRINT_PREFIX}${fingerprint(
    JSON.stringify({
      destinations: fingerprints,
      redact: options.redact,
      redactExtraRules: options.redactExtraRules ?? null,
    }),
  )}`;
  return { accountFingerprint, destinations };
}

function resolveDestination(
  config: LangSmithUploadDestinationConfig,
  options: LangSmithUploadWriterOptions,
  sourceProjectName?: string,
  updates?: Record<string, unknown>,
): ResolvedUploadDestination {
  if (!config || typeof config !== "object") throw new TypeError("Invalid upload destination");
  if (typeof config.apiKey !== "string" || config.apiKey.trim().length === 0) {
    throw new TypeError("An API key is required for each upload destination");
  }
  const apiUrl = normalizeApiUrl(config.apiUrl);
  const projectName = normalizeRequiredText(config.projectName, "project name");
  const workspaceId =
    config.workspaceId === undefined
      ? undefined
      : normalizeRequiredText(config.workspaceId, "workspace ID");
  const identity = JSON.stringify({
    apiKey: config.apiKey,
    apiUrl,
    projectName,
    workspaceId: workspaceId ?? null,
    ...(sourceProjectName === undefined ? {} : { sourceProjectName, updates: updates ?? null }),
  });
  const id = `${UPLOAD_DESTINATION_ID_PREFIX}${fingerprint(identity)}`;
  const anonymizer = createUploadAnonymizer(options.redact, options.redactExtraRules);
  const client = new Client({
    apiKey: config.apiKey,
    apiUrl,
    workspaceId: workspaceId ?? "",
    autoBatchTracing: false,
    tracingSamplingRate: 1,
    disablePromptCache: true,
    debug: false,
    omitTracedRuntimeInfo: true,
    tracingMode: "langsmith",
    ...(anonymizer === undefined ? {} : { anonymizer, hideMetadata: anonymizer }),
  });
  return {
    id,
    apiKey: config.apiKey,
    apiUrl,
    projectName,
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sourceProjectName === undefined ? {} : { sourceProjectName }),
    ...(updates === undefined ? {} : { updates }),
    ...(anonymizer === undefined ? {} : { anonymizer }),
    client,
  };
}

function resolveReplicaDestination(
  replica: LangSmithUploadReplicaConfig,
  primary: LangSmithUploadDestinationConfig,
  primaryProjectName: string,
  options: LangSmithUploadWriterOptions,
): ResolvedUploadDestination {
  if (!replica || typeof replica !== "object") throw new TypeError("Invalid upload replica");
  const updates = snapshotReplicaUpdates(replica.updates);
  const workspaceId = replica.workspaceId ?? primary.workspaceId;
  return resolveDestination(
    {
      apiKey: replica.apiKey ?? primary.apiKey,
      apiUrl: replica.apiUrl ?? primary.apiUrl,
      projectName: replica.projectName ?? primary.projectName,
      ...(workspaceId === undefined ? {} : { workspaceId }),
    },
    options,
    primaryProjectName,
    updates,
  );
}

function snapshotReplicaUpdates(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Replica updates must be an object");
  }
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    throw new TypeError("Replica updates must be JSON serializable");
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("Replica updates must be an object");
  }
  const updates = snapshot as Record<string, unknown>;
  for (const field of Object.keys(updates)) {
    if (UPLOAD_REPLICA_IDENTITY_UPDATE_FIELDS.has(field)) {
      throw new TypeError("Replica updates cannot override run identity");
    }
    if (!UPLOAD_REPLICA_PATCH_UPDATE_FIELDS.has(field)) {
      throw new TypeError("Unsupported replica update field");
    }
    if (
      field === "extra" &&
      (updates[field] === null ||
        typeof updates[field] !== "object" ||
        Array.isArray(updates[field]))
    ) {
      throw new TypeError("Replica extra updates must be an object");
    }
  }
  return canonicalJsonObject(updates, "Replica updates");
}

function normalizeApiUrl(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("An API endpoint is required for each upload destination");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("Invalid upload API endpoint");
  }
  if (
    (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
    endpoint.username.length > 0 ||
    endpoint.password.length > 0 ||
    endpoint.search.length > 0 ||
    endpoint.hash.length > 0
  ) {
    throw new TypeError("Invalid upload API endpoint");
  }
  return endpoint.toString().replace(UPLOAD_API_URL_TRAILING_SLASH_PATTERN, "");
}

function normalizeRequiredText(value: string, name: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    UPLOAD_CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new TypeError(`Invalid upload ${name}`);
  }
  return value.trim();
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, UPLOAD_FINGERPRINT_LENGTH);
}
