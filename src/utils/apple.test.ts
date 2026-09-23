import { describe, expect, it } from "vitest";
import { APPLE_CREDENTIALS } from "../constants.js";
import {
  acceptedSubmissionId,
  decodeBase64Credential,
  developerIdIdentity,
  developerIdRequirement,
  missingAppleCredentials,
} from "./apple.js";

const EVERY_CREDENTIAL = Object.fromEntries(APPLE_CREDENTIALS.map((name) => [name, "set"]));

const FIND_IDENTITY_OUTPUT = `
  1) 1111111111111111111111111111111111111111 "Apple Development: Someone (AAAAAAAAAA)"
  2) 2222222222222222222222222222222222222222 "Developer ID Application: LangChain, Inc. (BBBBBBBBBB)"
     2 valid identities found
`;

describe("the Apple credentials signing needs", () => {
  it("are the names the plugin repositories already store", () => {
    expect([...APPLE_CREDENTIALS]).toEqual([
      "APPLE_API_ISSUER",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "CSC_KEY_PASSWORD",
      "CSC_LINK",
    ]);
  });

  it("treats a blank value as missing", () => {
    expect(missingAppleCredentials({ ...EVERY_CREDENTIAL, CSC_LINK: "   " })).toEqual(["CSC_LINK"]);
  });

  it("is happy once they are all set", () => {
    expect(missingAppleCredentials(EVERY_CREDENTIAL)).toEqual([]);
  });
});

describe("reading the certificate", () => {
  it("decodes a base64 credential", () => {
    expect(decodeBase64Credential(Buffer.from("hello").toString("base64"), "CSC_LINK")).toEqual(
      Buffer.from("hello"),
    );
  });

  it("refuses a credential that decodes to nothing", () => {
    expect(() => decodeBase64Credential("", "CSC_LINK")).toThrow(
      "CSC_LINK is empty or is not base64",
    );
  });
});

describe("picking the identity to sign with", () => {
  it("takes the Developer ID one and not the development one", () => {
    expect(developerIdIdentity(FIND_IDENTITY_OUTPUT)).toBe(
      "Developer ID Application: LangChain, Inc. (BBBBBBBBBB)",
    );
  });

  it("refuses a certificate that cannot ship to users", () => {
    expect(() =>
      developerIdIdentity('  1) 1111111111111111111111111111111111111111 "Apple Development: A"'),
    ).toThrow("carries no Developer ID Application: identity");
  });

  it("pins the signature to the team that owns the certificate", () => {
    expect(developerIdRequirement("Developer ID Application: LangChain, Inc. (BBBBBBBBBB)")).toBe(
      "=anchor apple generic and certificate leaf[subject.OU] = BBBBBBBBBB",
    );
  });

  it("refuses an identity with no team in it", () => {
    expect(() => developerIdRequirement("Developer ID Application: LangChain")).toThrow(
      "ends in no Apple team ID",
    );
  });
});

describe("waiting for Apple", () => {
  it("accepts a submission Apple approved", () => {
    expect(acceptedSubmissionId({ id: "abc", status: "Accepted" })).toBe("abc");
  });

  it("refuses a submission Apple rejected", () => {
    expect(() => acceptedSubmissionId({ id: "abc", status: "Invalid" })).toThrow(
      "Apple notarization abc came back Invalid",
    );
  });

  it("refuses a submission that timed out with no verdict", () => {
    expect(() => acceptedSubmissionId({ id: "abc", status: "In Progress" })).toThrow(
      "came back In Progress",
    );
  });

  it("refuses a reply it cannot read at all", () => {
    expect(() => acceptedSubmissionId({})).toThrow(
      "Apple notarization submission came back an unreadable status",
    );
  });
});
