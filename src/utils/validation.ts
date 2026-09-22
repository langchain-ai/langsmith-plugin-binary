import { isAbsolute } from "node:path";
import { HEREDOC_TERMINATOR, MULTI_LINE_OR_CONTROL } from "../constants.js";

export function fail(field: string, wanted: string): never {
  throw new Error(`binary config field ${field} must be ${wanted}`);
}

export class Section {
  constructor(
    private readonly source: Record<string, unknown>,
    private readonly scope = "",
  ) {}

  private name(field: string): string {
    return this.scope === "" ? field : `${this.scope}.${field}`;
  }

  text(field: string): string {
    const value = this.source[field];
    if (typeof value !== "string" || value.trim() === "") {
      fail(this.name(field), "a non-empty string");
    }
    if (MULTI_LINE_OR_CONTROL.test(value as string)) {
      fail(this.name(field), "one line of ordinary text");
    }
    return value as string;
  }

  matching(field: string, allowed: RegExp, wanted: string): string {
    const value = this.text(field);
    if (!allowed.test(value)) fail(this.name(field), wanted);
    return value;
  }

  repositoryPath(field: string): string {
    const value = this.text(field);
    if (isAbsolute(value) || value.split("/").includes("..")) {
      fail(this.name(field), "a path inside the repository");
    }
    return value;
  }

  lines(field: string): string[] {
    const value = this.source[field];
    if (!Array.isArray(value) || value.length === 0) {
      fail(this.name(field), "a non-empty array of lines");
    }
    for (const line of value) {
      if (typeof line !== "string") fail(this.name(field), "an array of strings");
      if (MULTI_LINE_OR_CONTROL.test(line)) fail(this.name(field), "an array of single lines");
      if (line === HEREDOC_TERMINATOR) {
        fail(this.name(field), `an array with no line reading ${line}`);
      }
    }
    return value as string[];
  }

  section(field: string): Section {
    const value = this.source[field];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(this.name(field), "an object");
    }
    return new Section(value as Record<string, unknown>, this.name(field));
  }
}
