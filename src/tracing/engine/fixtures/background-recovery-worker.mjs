const fs = await import("node:fs");
const api = await import(process.argv[2]);
const {
  storageRoot,
  sessionId,
  writer,
  scanPath,
  reportPath,
  resultPath,
  readyPath,
  delayMs,
  cooldownMs,
  throwReportError,
} = JSON.parse(process.argv[3]);
const engine = api.createTracingEngine({ storageRoot, integration: "claude-code", writer });
const session = engine.forSession({
  sessionId,
  resolveScope: (expected) => expected,
  scheduleWake: () => {
    throw new Error("unexpected recovered-session launch");
  },
  reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
  backgroundRecovery: {
    minimumForeignAgeMs: 0,
    cooldownMs,
    optionsForSession: async (recoveredSessionId) => {
      fs.appendFileSync(scanPath, recoveredSessionId + "\n");
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      throw new Error("synthetic adapter context unavailable");
    },
    onReport: (report) => {
      fs.writeFileSync(reportPath, JSON.stringify(report));
      if (throwReportError) throw new Error("synthetic reporting callback failed");
    },
  },
});
try {
  if (readyPath) fs.writeFileSync(readyPath, "ready");
  fs.writeFileSync(resultPath, await session.drain());
} catch (error) {
  fs.writeFileSync(resultPath, String(error.stack ?? error));
  console.error(error);
  process.exitCode = 1;
}
