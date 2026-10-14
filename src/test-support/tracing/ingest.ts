import type { RunUnit } from "../models/upload.js";

export function runUnits(method: string, url: string, payload: Record<string, unknown>): RunUnit[] {
  if (!url.endsWith("/runs/batch"))
    return [{ method: method as RunUnit["method"], path: url, payload, wire: url }];
  const base = url.slice(0, -"/batch".length);
  const items = (key: string) => (payload[key] as Record<string, unknown>[] | undefined) ?? [];
  return [
    ...items("post").map((item) => ({
      method: "POST" as const,
      path: base,
      payload: item,
      wire: url,
    })),
    ...items("patch").map((item) => ({
      method: "PATCH" as const,
      path: `${base}/${String(item["id"])}`,
      payload: item,
      wire: url,
    })),
  ];
}
