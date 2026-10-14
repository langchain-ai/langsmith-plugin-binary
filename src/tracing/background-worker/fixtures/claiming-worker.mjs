const fs = await import("node:fs");
const { setTimeout: delay } = await import("node:timers/promises");
const storage = await import(process.argv[2]);
const { lockPath, gate, ready } = JSON.parse(process.argv[3]);
fs.writeFileSync(ready, "");
while (!fs.existsSync(gate)) await delay(5);
await storage.withFileLock(lockPath, () => {});
