import { COMMON_BOOLEAN_SETTINGS } from "./constants.js";
import { object } from "./utils/records.js";
export function invalid(raw) {
    return {
        status: "invalid",
        common: { enabled: false, defaultMuted: true },
        ...(raw === undefined ? {} : { raw }),
        diagnostics: [
            "Invalid or unreadable common config; ordinary fields discarded, privacy switches restricted.",
        ],
    };
}
export function absent() {
    return { status: "absent", common: {}, diagnostics: [] };
}
function parseReplica(value) {
    if (!object(value))
        return undefined;
    const replica = {};
    for (const [canonical, alias] of [
        ["api_url", "apiUrl"],
        ["api_key", "apiKey"],
        ["project", "projectName"],
    ]) {
        // Presence, not nullishness: an invalid canonical value must not select its alias.
        const selected = Object.hasOwn(value, canonical) ? canonical : alias;
        if (Object.hasOwn(value, selected)) {
            const entry = value[selected];
            if (typeof entry !== "string")
                return undefined;
            replica[canonical] = entry;
        }
    }
    if (Object.hasOwn(value, "updates")) {
        if (!object(value.updates))
            return undefined;
        replica.updates = value.updates;
    }
    return replica;
}
/** Parse a decoded JSON value (not JSON text). Unknown/adapter fields do not affect common validity. */
export function parseCommonConfig(value) {
    if (!object(value))
        return invalid();
    const common = {};
    const diagnostics = [];
    for (const field of ["enabled", "defaultMuted"]) {
        if (!Object.hasOwn(value, field))
            continue;
        const entry = value[field];
        common[field] = typeof entry === "boolean" ? entry : COMMON_BOOLEAN_SETTINGS[field].restrictive;
        if (typeof entry !== "boolean")
            diagnostics.push(`Invalid ${field}; using restrictive value.`);
    }
    for (const field of ["api_key", "api_url", "project"]) {
        if (!Object.hasOwn(value, field))
            continue;
        if (typeof value[field] !== "string")
            return invalid(value);
        common[field] = value[field];
    }
    if (Object.hasOwn(value, "redact")) {
        if (typeof value.redact !== "boolean")
            return invalid(value);
        common.redact = value.redact;
    }
    if (Object.hasOwn(value, "metadata")) {
        if (!object(value.metadata))
            return invalid(value);
        common.metadata = value.metadata;
    }
    if (Object.hasOwn(value, "replicas")) {
        if (!Array.isArray(value.replicas))
            return invalid(value);
        const replicas = [];
        for (const entry of value.replicas) {
            const replica = parseReplica(entry);
            if (replica === undefined)
                return invalid(value);
            replicas.push(replica);
        }
        common.replicas = replicas;
    }
    if (Object.hasOwn(value, "redact_extra_rules")) {
        if (!Array.isArray(value.redact_extra_rules))
            return invalid(value);
        const rules = [];
        for (const rule of value.redact_extra_rules) {
            if (!object(rule) || typeof rule.pattern !== "string" || !Object.hasOwn(rule, "pattern")) {
                return invalid(value);
            }
            const hasReplace = Object.hasOwn(rule, "replace");
            if (hasReplace && typeof rule.replace !== "string")
                return invalid(value);
            try {
                new RegExp(rule.pattern, "g");
            }
            catch {
                return invalid(value);
            }
            rules.push({
                pattern: rule.pattern,
                ...(hasReplace ? { replace: rule.replace } : {}),
            });
        }
        common.redact_extra_rules = rules;
    }
    return { status: "valid", common, raw: value, diagnostics };
}
//# sourceMappingURL=parse.js.map