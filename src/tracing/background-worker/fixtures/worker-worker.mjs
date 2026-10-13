const fs = await import("node:fs");
const { setTimeout: delay } = await import("node:timers/promises");
const api = await import(process.argv[2]);
const {
  mode,
  storageRoot,
  integration,
  sessionId,
  accountFingerprint,
  statePath,
  gatePath,
  maxAttempts,
  retryDelayMs,
} = JSON.parse(process.argv[3]);
const scope = { integration, sessionId, accountFingerprint };
function increment() {
  const count = Number(fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : 0) + 1;
  fs.writeFileSync(statePath, String(count));
  return count;
}
const worker = api.createBackgroundWorker({
  storageRoot,
  scope,
  resolveScope: () => scope,
  launchWorker: () => {
    throw new Error("unexpected nested worker launch");
  },
  retryPolicy: { maxAttempts: Number(maxAttempts), retryDelayMs: Number(retryDelayMs) },
  drainPending: async () => {
    const count = increment();
    if (mode === "hold") {
      fs.writeFileSync(statePath + ".entered", "ready");
      while (!fs.existsSync(gatePath)) await delay(5);
    }
    if (mode === "retry") return "retryable-failure";
    if (mode === "progress") return count < 3 ? "progressed" : "idle";
    return "idle";
  },
});
if (mode === "claim-gated" || mode === "start-gated") {
  fs.writeFileSync(statePath + ".ready", "ready");
  while (!fs.existsSync(gatePath)) await delay(5);
}
const result = await worker.run();
fs.writeFileSync(statePath + ".result", result);
