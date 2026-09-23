import { execFileSync } from "node:child_process";
import { MACH_O_ARCHES } from "../constants.js";
export function machOArch(arch) {
    const name = MACH_O_ARCHES[arch];
    if (!name)
        throw new Error(`No Mach-O architecture is known for ${arch}`);
    return name;
}
export function lipoArches(binary) {
    return execFileSync("/usr/bin/lipo", ["-archs", binary], { encoding: "utf-8" }).trim();
}
export function checkBuiltArch(binary, arch, readArches = lipoArches) {
    const wanted = machOArch(arch);
    const built = readArches(binary);
    if (built !== wanted)
        throw new Error(`The ${arch} build produced ${built}, not ${wanted}`);
}
export function checkReportedVersion(binary, version) {
    const reported = execFileSync(binary, ["--version"], { encoding: "utf-8" }).trim();
    if (reported !== version) {
        throw new Error(`The built binary reports version ${reported}, expected ${version}`);
    }
}
//# sourceMappingURL=binary-checks.js.map