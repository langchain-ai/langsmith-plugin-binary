const fs = await import("node:fs");
const api = await import(process.argv[2]);
const { storageRoot, sessionId, writer, callPath, resultPath } = JSON.parse(process.argv[3]);
const engine = api.createTracingEngine({ storageRoot, integration: "claude-code", writer });
const session = engine.forSession({
  sessionId,
  resolveScope: (expected) => expected,
  scheduleWake: () => {
    throw new Error("unexpected nested worker launch");
  },
  reconstruct: async () => {
    fs.writeFileSync(
      callPath,
      String(Number(fs.existsSync(callPath) ? fs.readFileSync(callPath, "utf8") : 0) + 1),
    );
    return { status: "deferred", reason: "missing-thread-identity" };
  },
});
try {
  fs.writeFileSync(resultPath, await session.drain());
} catch (error) {
  fs.writeFileSync(resultPath, String(error));
  process.exitCode = 1;
}
