import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { downloadAsset, verifyAdHocSignature } from "./download.js";
import type { BinaryTarget, InstallableRelease, ReleaseQuery, StagingOptions } from "./models.js";
import { reportedVersion } from "./utils/process.js";

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

async function stage(
  target: BinaryTarget,
  installDir: string,
  version: string,
  options: StagingOptions,
  fill: (temporary: string) => Promise<void>,
): Promise<string> {
  const now = (options.now ?? Date.now)();
  const verifySignature = options.verifySignature ?? verifyAdHocSignature;
  await fs.mkdir(installDir, { recursive: true, mode: 0o700 });

  const temporary = join(installDir, `.${target.executableName}.${process.pid}.${now}.tmp`);
  const installed = installedBinaryPath(target, installDir);
  try {
    await fill(temporary);
    await fs.chmod(temporary, 0o755);
    await verifySignature(temporary);
    const reported = await reportedVersion(temporary);
    if (reported !== version) {
      throw new Error(`the downloaded binary reports version ${reported}, expected ${version}`);
    }
    await fs.rename(temporary, installed);
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
  return stage(query.target, installDir, release.version, options, (temporary) =>
    downloadAsset(release, temporary, query),
  );
}

export function installRunningBinary(
  target: BinaryTarget,
  executablePath: string,
  installDir: string,
  version: string,
  options: StagingOptions = {},
): Promise<string> {
  return stage(target, installDir, version, options, (temporary) =>
    fs.copyFile(executablePath, temporary),
  );
}
