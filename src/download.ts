import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import {
  CODESIGN_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  LIST_TIMEOUT_MS,
  MAX_BINARY_BYTES,
  MAX_CHECKSUM_BYTES,
} from "./constants.js";
import type {
  BinaryTarget,
  InstallableRelease,
  ReleaseAsset,
  ReleaseQuery,
  SignatureVerifier,
} from "./models.js";
import { defaultReleasesApi, githubRequestHeaders, releaseDownloadPrefix } from "./target.js";
import { sha256FromChecksumFile, sha256FromDigestField } from "./utils/checksum.js";
import { writeFully } from "./utils/fs.js";

function trustedDownloadUrl(asset: ReleaseAsset, target: BinaryTarget, releasesApi: string): URL {
  const url = new URL(asset.browser_download_url);
  const trusted =
    releasesApi === defaultReleasesApi(target)
      ? url.href.startsWith(releaseDownloadPrefix(target))
      : url.origin === new URL(releasesApi).origin;
  if (!trusted) throw new Error(`release asset ${asset.name} has an unexpected download URL`);
  return url;
}

async function expectedSha256(release: InstallableRelease, query: ReleaseQuery): Promise<string> {
  const fromField = sha256FromDigestField(release.asset.digest);
  if (fromField) return fromField;

  const checksum = release.checksum;
  if (!checksum) {
    throw new Error(`release asset ${release.asset.name} has no SHA-256 digest or checksum file`);
  }
  if (checksum.size <= 0 || checksum.size > MAX_CHECKSUM_BYTES) {
    throw new Error(`release checksum size ${checksum.size} is outside the allowed range`);
  }

  const response = await query.fetchImpl(
    trustedDownloadUrl(checksum, query.target, query.releasesApi),
    {
      headers: githubRequestHeaders(query.target, query.currentVersion),
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new Error(`failed to download the release checksum: HTTP ${response.status}`);
  }
  return sha256FromChecksumFile(await response.text(), release.asset.name);
}

export async function downloadAsset(
  release: InstallableRelease,
  destination: string,
  query: ReleaseQuery,
): Promise<void> {
  const { asset } = release;
  if (asset.size <= 0 || asset.size > MAX_BINARY_BYTES) {
    throw new Error(`release asset size ${asset.size} is outside the allowed range`);
  }
  const url = trustedDownloadUrl(asset, query.target, query.releasesApi);
  const expected = await expectedSha256(release, query);

  const response = await query.fetchImpl(url, {
    headers: githubRequestHeaders(query.target, query.currentVersion),
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok || !response.body) {
    throw new Error(`failed to download the release asset: HTTP ${response.status}`);
  }

  const handle = await fs.open(destination, "wx", 0o700);
  const hash = createHash("sha256");
  let written = 0;
  try {
    for await (const rawChunk of response.body) {
      const chunk = Buffer.from(rawChunk);
      written += chunk.byteLength;
      if (written > asset.size) throw new Error("the release asset exceeds its declared size");
      hash.update(chunk);
      await writeFully(handle, chunk);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }

  if (written !== asset.size) {
    throw new Error(`release asset size mismatch: expected ${asset.size}, got ${written}`);
  }
  if (hash.digest("hex") !== expected) throw new Error("release asset SHA-256 mismatch");
}

export const verifyAdHocSignature: SignatureVerifier = (binary) =>
  new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/codesign",
      ["--verify", "--strict", binary],
      { timeout: CODESIGN_TIMEOUT_MS },
      (error) => (error ? reject(error) : resolve()),
    );
  });
