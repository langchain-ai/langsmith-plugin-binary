import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  REJECTED_FILE_SUFFIX,
  VERSION_CHECK_BUDGET_MS,
  VERSION_CHECK_MINIMUM_ATTEMPT_MS,
  VERSION_CHECK_RETRY_PAUSES_MS,
} from "./constants.js";
import { downloadAsset, verifyAdHocSignature } from "./download.js";
import type {
  BinaryTarget,
  InstallableRelease,
  ReleaseQuery,
  StagingOptions,
  StagingPlan,
} from "./models.js";
import { reportedVersion } from "./utils/process.js";
import {
  whyTheSignatureStoppedMatching,
  whyTheVersionCheckFailed,
  whyTheVersionIsWrong,
  worthKeeping,
  worthRetrying,
} from "./utils/staging.js";

export function installDirectory(target: BinaryTarget, home = homedir()): string {
  return join(home, target.installDirectoryName);
}

export function installedBinaryPath(target: BinaryTarget, installDir: string): string {
  return join(installDir, target.executableName);
}

export async function runningAsInstalledBinary(
  executablePath: string,
  installedPath: string,
): Promise<boolean> {
  const [running, installed] = await Promise.all([
    fs.realpath(executablePath).catch(() => undefined),
    fs.realpath(installedPath).catch(() => undefined),
  ]);
  return running !== undefined && running === installed;
}

async function stage({
  target,
  installDir,
  version,
  options,
  fill,
  confirmVersion,
}: StagingPlan): Promise<string> {
  const now = (options.now ?? Date.now)();
  const verifySignature = options.verifySignature ?? verifyAdHocSignature;
  const pause = options.pause ?? ((milliseconds: number) => sleep(milliseconds));
  await fs.mkdir(installDir, { recursive: true, mode: 0o700 });

  const temporary = join(installDir, `.${target.executableName}.${process.pid}.${now}.tmp`);
  const rejected = join(installDir, `.${target.executableName}${REJECTED_FILE_SUFFIX}`);
  const installed = installedBinaryPath(target, installDir);
  const moveAsideForInspection = (): Promise<string | undefined> =>
    fs.rename(temporary, rejected).then(
      () => rejected,
      () => undefined,
    );

  try {
    await fill(temporary);
    await fs.chmod(temporary, 0o755);
    await verifySignature(temporary);

    if (confirmVersion) {
      const spendBy = Date.now() + (options.versionCheckBudget ?? VERSION_CHECK_BUDGET_MS);
      const left = (): number => spendBy - Date.now();
      let check = await reportedVersion(temporary, left());
      for (const wait of VERSION_CHECK_RETRY_PAUSES_MS) {
        if (check.ok || !worthRetrying(check.failure)) break;
        if (left() - wait < VERSION_CHECK_MINIMUM_ATTEMPT_MS) break;
        await pause(wait);
        try {
          await verifySignature(temporary);
        } catch (error) {
          throw new Error(whyTheSignatureStoppedMatching(error, await moveAsideForInspection()), {
            cause: error,
          });
        }
        check = await reportedVersion(temporary, left());
      }
      if (!check.ok) {
        const staged = worthKeeping(check.failure) ? await moveAsideForInspection() : undefined;
        throw new Error(whyTheVersionCheckFailed(check.failure, staged));
      }
      if (check.reported !== version) {
        throw new Error(whyTheVersionIsWrong(check.reported, version));
      }
    }
    await fs.rename(temporary, installed);
    await fs.unlink(rejected).catch(() => undefined);
    return installed;
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function installRelease(
  release: InstallableRelease,
  installDir: string,
  query: ReleaseQuery,
  options: StagingOptions = {},
): Promise<string> {
  return stage({
    target: query.target,
    installDir,
    version: release.version,
    options,
    fill: (temporary) => downloadAsset(release, temporary, query),
    confirmVersion: true,
  });
}

export function installRunningBinary(
  target: BinaryTarget,
  executablePath: string,
  installDir: string,
  version: string,
  options: StagingOptions = {},
): Promise<string> {
  return stage({
    target,
    installDir,
    version,
    options,
    fill: (temporary) => fs.copyFile(executablePath, temporary),
    confirmVersion: false,
  });
}
