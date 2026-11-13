import { mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BYTES_PER_MEGABYTE,
  CGROUP_CPU_FILE,
  CGROUP_CPU_USAGE,
  CGROUP_EVENTS_FILE,
  CGROUP_KILL_FILE,
  CGROUP_MEMORY_PEAK_FILE,
  CGROUP_POPULATED,
  CGROUP_PROCESSES_FILE,
  ENGINE_EXIT_POLL_MS,
  ENGINE_EXIT_TIMEOUT_MS,
  USAGE_LINE,
  USAGE_PERCENTILES,
} from "../constants.ts";
import type { EngineUsage, UsageSample } from "../models.ts";
import { quoteForShell } from "../utils/text.ts";

export function createUsageGroup(root: string, name: string): string {
  const group = join(root, name);
  mkdirSync(group);
  return group;
}

export function commandInGroup(group: string, command: string): string {
  return `echo $$ > ${quoteForShell(join(group, CGROUP_PROCESSES_FILE))} || exit 1\n${command}`;
}

async function waitUntilEmpty(group: string): Promise<boolean> {
  const deadline = Date.now() + ENGINE_EXIT_TIMEOUT_MS;
  while (CGROUP_POPULATED.test(readFileSync(join(group, CGROUP_EVENTS_FILE), "utf8"))) {
    if (Date.now() >= deadline) return false;
    await sleep(ENGINE_EXIT_POLL_MS);
  }
  return true;
}

export async function closeUsageGroup(group: string): Promise<EngineUsage> {
  const exitedOnItsOwn = await waitUntilEmpty(group);
  if (!exitedOnItsOwn) {
    writeFileSync(join(group, CGROUP_KILL_FILE), "1");
    await waitUntilEmpty(group);
  }
  const cpuMicroseconds = CGROUP_CPU_USAGE.exec(readFileSync(join(group, CGROUP_CPU_FILE), "utf8"));
  const usage: EngineUsage = {
    cpuMs: Math.round(Number(cpuMicroseconds?.[1] ?? 0) / 1000),
    peakMemoryBytes: Number(readFileSync(join(group, CGROUP_MEMORY_PEAK_FILE), "utf8")),
    exitedOnItsOwn,
  };
  rmdirSync(group);
  return usage;
}

function percentiles(values: number[]): string {
  const sorted = values.toSorted((a, b) => a - b);
  return USAGE_PERCENTILES.map(
    (percent) => `p${percent} ${sorted[Math.ceil((percent / 100) * sorted.length) - 1]}`,
  ).join(", ");
}

export function usageLine(session: string, usage: EngineUsage): string {
  const megabytes = (usage.peakMemoryBytes / BYTES_PER_MEGABYTE).toFixed(1);
  return `usage ${session}: ${usage.cpuMs} ms CPU, ${megabytes} MB peak memory`;
}

export function usagesFromLog(log: string): UsageSample[] {
  return [...log.matchAll(USAGE_LINE)].map((match) => ({
    cpuMs: Number(match[1]),
    peakMemoryBytes: Number(match[2]) * BYTES_PER_MEGABYTE,
  }));
}

export function usageSummary(usages: UsageSample[]): string {
  const cpu = percentiles(usages.map((usage) => usage.cpuMs));
  const memory = percentiles(
    usages.map((usage) => Math.round((usage.peakMemoryBytes / BYTES_PER_MEGABYTE) * 10) / 10),
  );
  return `${usages.length} sessions, CPU ms ${cpu}, peak memory MB ${memory}`;
}
