import { createSecretAnonymizer } from "langsmith/anonymizer";
export function createUploadAnonymizer(enabled, extraRules) {
    if (!enabled)
        return undefined;
    const normalizedRules = extraRules?.map(({ pattern, replace }) => ({
        pattern,
        ...(replace === undefined ? {} : { replace }),
    }));
    return createSecretAnonymizer(normalizedRules === undefined ? {} : { extraRules: normalizedRules });
}
export function redactSdkOmittedFields(payload, anonymizer) {
    if (!anonymizer)
        return;
    if (payload["tags"] !== undefined)
        payload["tags"] = anonymizer(payload["tags"]);
    if (payload["serialized"] !== undefined) {
        payload["serialized"] = anonymizer(payload["serialized"]);
    }
    if (payload["events"] !== undefined)
        payload["events"] = anonymizer(payload["events"]);
}
//# sourceMappingURL=redaction.js.map