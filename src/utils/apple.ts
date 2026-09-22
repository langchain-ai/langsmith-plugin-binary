import { writeFile } from "node:fs/promises";
import {
  APPLE_CREDENTIALS,
  DEVELOPER_ID_PREFIX,
  IDENTITY_LINE,
  TEAM_ID_SUFFIX,
} from "../constants.js";
import type { Environment } from "../models.js";
import { security } from "./process.js";

export function missingAppleCredentials(env: Environment): string[] {
  return APPLE_CREDENTIALS.filter((name) => (env[name] ?? "").trim() === "");
}

export function decodeBase64Credential(value: string, name: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength === 0) throw new Error(`${name} is empty or is not base64`);
  return decoded;
}

export function developerIdIdentity(findIdentityOutput: string): string {
  const identity = [...findIdentityOutput.matchAll(IDENTITY_LINE)]
    .map((match) => match[1]!)
    .find((name) => name.startsWith(DEVELOPER_ID_PREFIX));
  if (!identity) throw new Error(`CSC_LINK carries no ${DEVELOPER_ID_PREFIX} identity`);
  return identity;
}

export function developerIdRequirement(identity: string): string {
  const teamId = TEAM_ID_SUFFIX.exec(identity)?.[1];
  if (!teamId) throw new Error(`the identity ${identity} ends in no Apple team ID`);
  return `=anchor apple generic and certificate leaf[subject.OU] = ${teamId}`;
}

export function acceptedSubmissionId(submission: { id?: string; status?: string }): string {
  const { id = "submission", status = "an unreadable status" } = submission;
  if (status !== "Accepted") throw new Error(`Apple notarization ${id} came back ${status}`);
  return id;
}

export function userKeychains(): string[] {
  return [...security(["list-keychains", "-d", "user"]).matchAll(/"([^"]+)"/g)].map(
    (match) => match[1]!,
  );
}

export function searchUserKeychains(keychains: string[]): void {
  security(["list-keychains", "-d", "user", "-s", ...keychains]);
}

export async function writeCredentialFile(
  path: string,
  value: string,
  name: string,
): Promise<string> {
  await writeFile(path, decodeBase64Credential(value, name), { mode: 0o600, flag: "wx" });
  return path;
}
