import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPlan, outputPath } from "./build.js";
import { acceptedSubmissionId, developerIdIdentity, developerIdRequirement, missingAppleCredentials, searchUserKeychains, userKeychains, writeCredentialFile, } from "./utils/apple.js";
import { codesign, security, securityWithoutEchoingCredentials } from "./utils/process.js";
async function signAndNotarize(binaryPath, entitlementsPath, env) {
    const workspace = await mkdtemp(join(tmpdir(), "langsmith-binary-signing-"));
    const keychain = join(workspace, "signing.keychain-db");
    const password = randomBytes(32).toString("hex");
    const originalKeychains = userKeychains();
    try {
        const certificate = await writeCredentialFile(join(workspace, "developer-id-application.p12"), env.CSC_LINK, "CSC_LINK");
        const notarizationKey = await writeCredentialFile(join(workspace, "notarization-key.p8"), env.APPLE_API_KEY, "APPLE_API_KEY");
        securityWithoutEchoingCredentials(["create-keychain", "-p", password, keychain], "create the temporary signing keychain");
        searchUserKeychains([keychain, ...originalKeychains]);
        securityWithoutEchoingCredentials(["unlock-keychain", "-p", password, keychain], "unlock the temporary signing keychain");
        securityWithoutEchoingCredentials([
            "import",
            certificate,
            "-P",
            env.CSC_KEY_PASSWORD,
            "-f",
            "pkcs12",
            "-T",
            "/usr/bin/codesign",
            "-k",
            keychain,
        ], "import CSC_LINK into the temporary signing keychain");
        securityWithoutEchoingCredentials(["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychain], "let codesign use the imported certificate");
        const identity = developerIdIdentity(security(["find-identity", "-v", "-p", "codesigning", keychain]));
        codesign([
            "--force",
            "--options",
            "runtime",
            "--timestamp",
            "--entitlements",
            entitlementsPath,
            "--keychain",
            keychain,
            "--sign",
            identity,
            binaryPath,
        ]);
        codesign([
            "--verify",
            "--strict",
            "--verbose=2",
            "-R",
            developerIdRequirement(identity),
            binaryPath,
        ]);
        const archive = join(workspace, "notarization.zip");
        execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", binaryPath, archive], {
            stdio: "inherit",
        });
        const submission = JSON.parse(execFileSync("/usr/bin/xcrun", [
            "notarytool",
            "submit",
            archive,
            "--key",
            notarizationKey,
            "--key-id",
            env.APPLE_API_KEY_ID,
            "--issuer",
            env.APPLE_API_ISSUER,
            "--wait",
            "--timeout",
            "30m",
            "--output-format",
            "json",
        ], { encoding: "utf-8" }));
        return { identity, submissionId: acceptedSubmissionId(submission) };
    }
    finally {
        searchUserKeychains(originalKeychains);
        await rm(workspace, { force: true, recursive: true });
    }
}
export async function sign(loaded, options = {}) {
    const { env = process.env, log = console.log } = options;
    const missing = missingAppleCredentials(env);
    if (missing.length > 0) {
        throw new Error(`these Apple credentials are not set: ${missing.join(", ")}`);
    }
    const plan = buildPlan(loaded);
    const target = options.binaryPath ?? outputPath(plan, process.arch);
    if (!existsSync(target))
        throw new Error(`there is no binary to sign at ${target}`);
    const entitlements = resolve(loaded.repositoryRoot, loaded.config.sign.entitlements);
    const { identity, submissionId } = await signAndNotarize(target, entitlements, env);
    log(`Signed ${target} as ${identity}`);
    log(`Apple notarization ${submissionId} accepted`);
    return submissionId;
}
//# sourceMappingURL=sign.js.map