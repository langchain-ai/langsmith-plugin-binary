import type { TextBlock } from "../models.ts";

export function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function containsText(haystack: string, text: string): boolean {
  return haystack.includes(JSON.stringify(text).slice(1, -1));
}

export function textOf(content: unknown): string {
  return textBlocksOf(content).join("\n");
}

export function textBlocksOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is TextBlock => block?.type === "text" || block?.type === "input_text")
    .map((block) => block.text);
}
