const fs = await import("node:fs");
const api = await import(process.argv[2]);
const { root, sessionId, writer } = JSON.parse(process.argv[3]);
const session = api
  .createTracingEngine({ storageRoot: root, integration: "claude-code", writer })
  .forSession({
    sessionId,
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      throw new Error("nested launch");
    },
    reconstruct: async () => ({
      status: "ready",
      outputs: [{ eventId: "output", submission: JSON.parse(process.argv[4]) }],
    }),
  });
const result = await session.drain();
fs.writeFileSync(root + "/pending-" + sessionId, result);
fs.renameSync(root + "/pending-" + sessionId, root + "/result-" + sessionId);
