import { createHash } from "node:crypto";
import type { UploadLogin } from "../../auth/models.js";
import { refusedLoginReplicas } from "../../auth/credential.js";
import { sameServer } from "../../auth/profile.js";
import { sdkSetting } from "../../utils/sdk/normalize.js";
import { canonicalJsonObject } from "../../utils/validation/objects.js";
import {
  UPLOAD_ACCOUNT_FINGERPRINT_PREFIX,
  UPLOAD_API_URL_TRAILING_SLASH_PATTERN,
  UPLOAD_CONTROL_CHARACTER_PATTERN,
  UPLOAD_CREDENTIAL_REQUIRED_MESSAGE,
  UPLOAD_DESTINATION_ID_PREFIX,
  UPLOAD_FINGERPRINT_LENGTH,
  UPLOAD_LOGIN_FIELD_NAMES,
  UPLOAD_LOGIN_INVALID_MESSAGE,
  UPLOAD_REPLICA_IDENTITY_UPDATE_FIELDS,
  UPLOAD_REPLICA_PATCH_UPDATE_FIELDS,
} from "./constants.js";
import type {
  LangSmithUploadDestinationConfig,
  LangSmithUploadReplicaConfig,
  LangSmithUploadIdentityOptions,
  ResolvedUploadDestinationIdentity,
  ResolvedUploadDestinationIdentities,
} from "./models.js";

export function resolveUploadDestinationIdentities(
  options: LangSmithUploadIdentityOptions,
): ResolvedUploadDestinationIdentities {
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
  const routedReplicas =
    primary && typeof primary === "object" && !hasApiKey(primary.apiKey)
      ? replicas.filter(
          (replica) =>
            !replica ||
            typeof replica !== "object" ||
            hasApiKey(replica.apiKey) ||
            (primary.login !== undefined &&
              (replica.apiUrl === undefined || sameServer(replica.apiUrl, primary.apiUrl))),
        )
      : replicas;
  if (replicas.length > 0 && routedReplicas.length === 0 && primary?.login !== undefined)
    throw new TypeError(refusedLoginReplicas(replicas, primary.apiUrl));
  const primaryProjectName =
    routedReplicas.length === 0 || primary === undefined
      ? undefined
      : normalizeRequiredText(primary.projectName, "project name");
  const destinations =
    routedReplicas.length === 0
      ? options.destinations.map((destination) => resolveDestination(destination))
      : routedReplicas.map((replica) =>
          resolveReplicaDestination(replica, primary!, primaryProjectName!),
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
  sourceProjectName?: string,
  updates?: Record<string, unknown>,
  replicaProjectName?: string | null,
): ResolvedUploadDestinationIdentity {
  if (!config || typeof config !== "object") throw new TypeError("Invalid upload destination");
  const login = hasApiKey(config.apiKey) ? undefined : normalizeLogin(config.login);
  if (login === undefined && !hasApiKey(config.apiKey)) {
    throw new TypeError(UPLOAD_CREDENTIAL_REQUIRED_MESSAGE);
  }
  const apiUrl = normalizeApiUrl(config.apiUrl);
  const projectName = normalizeRequiredText(config.projectName, "project name");
  const agentId =
    config.agentId === undefined ? undefined : normalizeRequiredText(config.agentId, "agent ID");
  const workspaceId =
    config.workspaceId === undefined
      ? undefined
      : sdkSetting(normalizeRequiredText(config.workspaceId, "workspace ID"));
  const identity = JSON.stringify({
    ...(login === undefined ? { apiKey: config.apiKey } : { login }),
    apiUrl,
    workspaceId: workspaceId ?? null,
    ...(sourceProjectName === undefined
      ? {}
      : { projectName: replicaProjectName ?? null, updates: updates ?? null }),
  });
  const id = `${UPLOAD_DESTINATION_ID_PREFIX}${fingerprint(identity)}`;
  return {
    id,
    ...(login === undefined ? { apiKey: config.apiKey! } : { login }),
    apiUrl,
    projectName,
    ...(agentId === undefined ? {} : { agentId }),
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(sourceProjectName === undefined ? {} : { sourceProjectName }),
    ...(updates === undefined ? {} : { updates }),
  };
}

function resolveReplicaDestination(
  replica: LangSmithUploadReplicaConfig,
  primary: LangSmithUploadDestinationConfig,
  primaryProjectName: string,
): ResolvedUploadDestinationIdentity {
  if (!replica || typeof replica !== "object") throw new TypeError("Invalid upload replica");
  const updates = snapshotReplicaUpdates(replica.updates);
  const workspaceId = replica.workspaceId ?? primary.workspaceId;
  const ownKey = hasApiKey(replica.apiKey);
  const apiKey = ownKey ? replica.apiKey : primary.apiKey;
  return resolveDestination(
    {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(!ownKey && primary.login ? { login: primary.login } : {}),
      apiUrl: replica.apiUrl ?? primary.apiUrl,
      projectName: replica.projectName ?? primary.projectName,
      ...(replica.projectName === undefined && primary.agentId !== undefined
        ? { agentId: primary.agentId }
        : {}),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    },
    primaryProjectName,
    updates,
    replica.projectName === undefined
      ? null
      : normalizeRequiredText(replica.projectName, "project name"),
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

function normalizeLogin(login: UploadLogin | undefined): UploadLogin | undefined {
  if (login === undefined) return undefined;
  if (!login || typeof login !== "object") throw new TypeError(UPLOAD_LOGIN_INVALID_MESSAGE);
  const workspaceId =
    login.workspaceId === undefined
      ? undefined
      : sdkSetting(normalizeRequiredText(login.workspaceId, UPLOAD_LOGIN_FIELD_NAMES.workspaceId));
  return {
    configPath: normalizeRequiredText(login.configPath, UPLOAD_LOGIN_FIELD_NAMES.configPath),
    profile: normalizeRequiredText(login.profile, UPLOAD_LOGIN_FIELD_NAMES.profile),
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}

function hasApiKey(value: unknown): value is string {
  return sdkSetting(value) !== undefined;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, UPLOAD_FINGERPRINT_LENGTH);
}
