const fs = await import("node:fs");
const api = await import(process.argv[2]);
const { storageRoot, sessionId, writer, resultPath, reconstructOutput } = JSON.parse(
  process.argv[3],
);
const engine = api.createTracingEngine({ storageRoot, integration: "claude-code", writer });
const session = engine.forSession({
  sessionId,
  resolveScope: (expected) => expected,
  scheduleWake: () => {
    throw new Error("unexpected nested worker launch");
  },
  reconstruct: async (job) => {
    if (!reconstructOutput) return { status: "deferred", reason: "missing-thread-identity" };
    const runId = "33333333-3333-4333-8333-333333333333";
    return {
      status: "ready",
      outputs: [
        {
          eventId: "recovered-output",
          submission: {
            operation: "post",
            integration: "claude-code",
            privacyMode: "full",
            metadata: {
              integration: "claude-code",
              threadId: "recovered-thread",
              agentType: "root",
              runType: "root",
            },
            run: {
              id: runId,
              name: "recovered run",
              run_type: "chain",
              start_time: "2026-10-10T12:00:00.000Z",
              trace_id: runId,
              dotted_order: "20261010T120000000000Z" + runId,
              inputs: { source: job.eventId },
            },
          },
        },
      ],
    };
  },
});
try {
  fs.writeFileSync(resultPath, await session.drain());
} catch (error) {
  fs.writeFileSync(resultPath, String(error.stack ?? error));
  console.error(error);
  process.exitCode = 1;
}
