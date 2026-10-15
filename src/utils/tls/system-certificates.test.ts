import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trustSystemCertificates } from "./system-certificates.js";

vi.mock("node:tls", () => ({ getCACertificates: undefined }));

const ROOT_A = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
const ROOT_B = "-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----";

let directory: string;
let file: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "plugins base certificates "));
  file = join(directory, "system.pem");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

it("keeps the user's own extra certificates alongside the computer's", () => {
  const own = join(directory, "own.pem");
  writeFileSync(own, `${ROOT_A}\n`);
  const result = trustSystemCertificates(file, { NODE_EXTRA_CA_CERTS: own }, () => [ROOT_B]);
  expect(result).toEqual({ environment: { NODE_EXTRA_CA_CERTS: file } });
  expect(readFileSync(file, "utf8")).toBe(`${ROOT_A}\n${ROOT_B}\n`);
});

it("leaves a worker started by another worker as it is", () => {
  writeFileSync(file, `${ROOT_A}\n`);
  const environment = { NODE_EXTRA_CA_CERTS: file };
  expect(trustSystemCertificates(file, environment, () => [ROOT_B])).toEqual({ environment });
  expect(readFileSync(file, "utf8")).toBe(`${ROOT_A}\n`);
});

it("never repeats a certificate, even when the variable spells the engine's file differently", () => {
  const ownSpelling = `${directory}/./system.pem`;
  trustSystemCertificates(file, {}, () => [ROOT_A, ROOT_B]);
  for (let launch = 0; launch < 3; launch += 1) {
    trustSystemCertificates(file, { NODE_EXTRA_CA_CERTS: ownSpelling }, () => [ROOT_A, ROOT_B]);
  }
  expect(readFileSync(file, "utf8")).toBe(`${ROOT_A}\n${ROOT_B}\n`);
});

it("changes nothing when the runtime cannot read the computer's certificates", () => {
  expect(trustSystemCertificates(file, {})).toEqual({ environment: {} });
  expect(trustSystemCertificates(file, {}, () => [])).toEqual({ environment: {} });
  expect(statSync(file, { throwIfNoEntry: false })).toBeUndefined();
});

it("keeps the current settings and warns when the certificates cannot be gathered", () => {
  const failing = trustSystemCertificates(file, {}, () => {
    throw new Error("store locked");
  });
  expect(failing).toEqual({ environment: {}, warning: expect.stringContaining("store locked") });
  const missing = { NODE_EXTRA_CA_CERTS: join(directory, "missing.pem") };
  const unreadable = trustSystemCertificates(file, missing, () => [ROOT_B]);
  expect(unreadable).toEqual({ environment: missing, warning: expect.stringContaining("ENOENT") });
});

it("does not rewrite the certificate file when nothing changed", () => {
  trustSystemCertificates(file, {}, () => [ROOT_A]);
  chmodSync(file, 0o400);
  expect(trustSystemCertificates(file, {}, () => [ROOT_A]).warning).toBeUndefined();
  chmodSync(file, 0o600);
  trustSystemCertificates(file, {}, () => [ROOT_B]);
  expect(readFileSync(file, "utf8")).toBe(`${ROOT_B}\n`);
});
