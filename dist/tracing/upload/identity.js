import { resolveUploadDestinationIdentities } from "./destination-identity.js";
export function resolveUploadDestinationFingerprint(options) {
    return resolveUploadDestinationIdentities(options).accountFingerprint;
}
//# sourceMappingURL=identity.js.map