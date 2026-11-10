export function quoteForShell(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function containsText(haystack: string, text: string): boolean {
  return haystack.includes(JSON.stringify(text).slice(1, -1));
}
