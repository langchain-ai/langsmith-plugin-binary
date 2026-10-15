import { readFileSync, writeFileSync } from "node:fs";
import * as tls from "node:tls";
import { describe } from "../errors.js";
import { CERTIFICATE_FILE_ENCODING, CERTIFICATE_PATTERN, EXTRA_CERTIFICATES_VARIABLE, SYSTEM_CERTIFICATE_STORE, SYSTEM_CERTIFICATES_WARNING, } from "./tls-constants.js";
export function trustSystemCertificates(file, environment, readSystem = readSystemStore) {
    const existing = environment[EXTRA_CERTIFICATES_VARIABLE] || undefined;
    if (existing === file)
        return { environment };
    try {
        const system = readSystem();
        if (system.length === 0)
            return { environment };
        const extra = existing === undefined ? [] : [readFileSync(existing, CERTIFICATE_FILE_ENCODING)];
        writeIfChanged(file, bundle([...extra, ...system]));
        return { environment: { ...environment, [EXTRA_CERTIFICATES_VARIABLE]: file } };
    }
    catch (error) {
        return { environment, warning: `${SYSTEM_CERTIFICATES_WARNING} ${describe(error)}` };
    }
}
function readSystemStore() {
    return typeof tls.getCACertificates === "function"
        ? tls.getCACertificates(SYSTEM_CERTIFICATE_STORE)
        : [];
}
function bundle(sources) {
    const certificates = new Set(sources.flatMap((source) => source.match(CERTIFICATE_PATTERN) ?? []));
    return [...certificates].map((certificate) => `${certificate}\n`).join("");
}
function writeIfChanged(file, contents) {
    if (readIfPresent(file) !== contents)
        writeFileSync(file, contents);
}
function readIfPresent(file) {
    try {
        return readFileSync(file, CERTIFICATE_FILE_ENCODING);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=system-certificates.js.map