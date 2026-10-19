const warned = new Set();
export function warnOnce(lines) {
    for (const line of lines) {
        if (warned.has(line))
            continue;
        warned.add(line);
        console.warn(line);
    }
}
//# sourceMappingURL=warnings.js.map