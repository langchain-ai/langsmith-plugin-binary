const fs = await import("node:fs");
const { setTimeout: delay } = await import("node:timers/promises");
const api = await import(process.argv[2]);
const { mode, root, scope, passes } = JSON.parse(process.argv[3]);
const result = await api
  .createBackgroundWorker({
    storageRoot: root,
    scope,
    resolveScope: () => scope,
    launchWorker: () => 0,
    retryPolicy: { maxAttempts: 2, retryDelayMs: 20_000 },
    drainPending: async () => {
      const count = Number(fs.existsSync(passes) ? fs.readFileSync(passes, "utf8") : 0) + 1;
      fs.writeFileSync(passes, String(count));
      if (mode === "hold") for (;;) await delay(5);
      if (mode === "retry") return "retryable-failure";
      return count < 3 ? "progressed" : "idle";
    },
  })
  .run();
fs.writeFileSync(passes + ".result", result);
