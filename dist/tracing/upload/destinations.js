import { createHash } from "node:crypto";
import { Client } from "langsmith";
import { UPLOAD_ACCOUNT_FINGERPRINT_PREFIX, UPLOAD_API_URL_TRAILING_SLASH_PATTERN, UPLOAD_CONTROL_CHARACTER_PATTERN, UPLOAD_DESTINATION_ID_PREFIX, UPLOAD_FINGERPRINT_LENGTH, } from "./constants.js";
import { createUploadAnonymizer } from "./redaction.js";
export function resolveUploadDestinations(options) {
    if (!Array.isArray(options.destinations) || options.destinations.length === 0) {
        throw new TypeError("At least one upload destination is required");
    }
    if (typeof options.redact !== "boolean")
        throw new TypeError("A redaction setting is required");
    const destinations = options.destinations.map((destination) => resolveDestination(destination, options));
    const ids = new Set();
    for (const destination of destinations) {
        if (ids.has(destination.id))
            throw new TypeError("Upload destinations must be unique");
        ids.add(destination.id);
    }
    const fingerprints = destinations.map(({ id }) => id).toSorted();
    const accountFingerprint = `${UPLOAD_ACCOUNT_FINGERPRINT_PREFIX}${fingerprint(JSON.stringify({
        destinations: fingerprints,
        redact: options.redact,
        redactExtraRules: options.redactExtraRules ?? null,
    }))}`;
    return { accountFingerprint, destinations };
}
function resolveDestination(config, options) {
    if (!config || typeof config !== "object")
        throw new TypeError("Invalid upload destination");
    if (typeof config.apiKey !== "string" || config.apiKey.trim().length === 0) {
        throw new TypeError("An API key is required for each upload destination");
    }
    const apiUrl = normalizeApiUrl(config.apiUrl);
    const projectName = normalizeRequiredText(config.projectName, "project name");
    const workspaceId = config.workspaceId === undefined
        ? undefined
        : normalizeRequiredText(config.workspaceId, "workspace ID");
    const identity = JSON.stringify({
        apiKey: config.apiKey,
        apiUrl,
        projectName,
        workspaceId: workspaceId ?? null,
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
        ...(anonymizer === undefined ? {} : { anonymizer }),
        client,
    };
}
function normalizeApiUrl(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new TypeError("An API endpoint is required for each upload destination");
    }
    let endpoint;
    try {
        endpoint = new URL(value);
    }
    catch {
        throw new TypeError("Invalid upload API endpoint");
    }
    if ((endpoint.protocol !== "https:" && endpoint.protocol !== "http:") ||
        endpoint.username.length > 0 ||
        endpoint.password.length > 0 ||
        endpoint.search.length > 0 ||
        endpoint.hash.length > 0) {
        throw new TypeError("Invalid upload API endpoint");
    }
    return endpoint.toString().replace(UPLOAD_API_URL_TRAILING_SLASH_PATTERN, "");
}
function normalizeRequiredText(value, name) {
    if (typeof value !== "string" ||
        value.trim().length === 0 ||
        UPLOAD_CONTROL_CHARACTER_PATTERN.test(value)) {
        throw new TypeError(`Invalid upload ${name}`);
    }
    return value.trim();
}
function fingerprint(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, UPLOAD_FINGERPRINT_LENGTH);
}
//# sourceMappingURL=destinations.js.map