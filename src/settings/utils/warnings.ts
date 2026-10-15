const warned = new Set<string>();

export function warnOnce(lines: readonly string[]): void {
  for (const line of lines) {
    if (warned.has(line)) continue;
    warned.add(line);
    console.warn(line);
  }
}
