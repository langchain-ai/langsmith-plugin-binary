import { VERSION } from "../constants.js";
import type { ParsedVersion } from "../models.js";

export function parseVersion(version: string): ParsedVersion | undefined {
  const match = VERSION.exec(version.trim());
  if (!match) return undefined;
  return {
    numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
    final: match[4] === undefined ? 1 : 0,
    label: match[4] ?? "",
    iteration: match[5] === undefined ? 0 : Number(match[5]),
  };
}

export function isVersion(version: string): boolean {
  return parseVersion(version) !== undefined;
}

function compare(next: ParsedVersion, installed: ParsedVersion): number {
  for (let index = 0; index < next.numbers.length; index += 1) {
    const difference = next.numbers[index]! - installed.numbers[index]!;
    if (difference !== 0) return difference;
  }
  if (next.final !== installed.final) return next.final - installed.final;
  if (next.label !== installed.label) return next.label < installed.label ? -1 : 1;
  return next.iteration - installed.iteration;
}

export function isVersionNewer(candidate: string, current: string): boolean {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  return compare(next, installed) > 0;
}
