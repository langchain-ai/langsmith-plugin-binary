import { basename } from "node:path";

export function sha256FromDigestField(digest: string | null): string | undefined {
  const match = /^sha256:([a-f0-9]{64})$/i.exec(digest ?? "");
  return match?.[1]!.toLowerCase();
}

export function sha256FromChecksumFile(text: string, assetName: string): string {
  const match = /^([a-f0-9]{64})\s+[* ]?(\S+)\s*$/im.exec(text);
  if (!match || basename(match[2]!) !== assetName) {
    throw new Error(`release asset ${assetName} has an invalid SHA-256 checksum file`);
  }
  return match[1]!.toLowerCase();
}
