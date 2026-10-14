const api = await import(process.argv[2]);
const { root, sessionId, writer, runIds } = JSON.parse(process.argv[3]);
const submission = (id) => ({
  operation: "post",
  integration: "claude-code",
  privacyMode: "full",
  metadata: {
    integration: "claude-code",
    threadId: "thread-disk",
    agentType: "root",
    runType: "root",
  },
  run: {
    id,
    name: "root run",
    run_type: "chain",
    start_time: "2026-10-10T12:00:00.000Z",
    end_time: "2026-10-10T12:00:01.000Z",
    trace_id: id,
    dotted_order: `20261010T120000000000Z${id}`,
    inputs: {},
  },
});
const session = api
  .createTracingEngine({ storageRoot: root, integration: "claude-code", writer })
  .forSession({
    sessionId,
    resolveScope: (expected) => expected,
    scheduleWake: () => {
      throw new Error("no worker in this test");
    },
    reconstruct: async () => ({ status: "deferred", reason: "missing-thread-identity" }),
  });
for (const [index, id] of runIds.entries())
  await session
    .capture({
      turnId: `turn-${index}`,
      eventId: `event-${index}`,
      submission: submission(id),
      turnEvidence: { rootRunId: id, childRunIds: [], closureState: "authoritative" },
    })
    .catch(() => undefined);
await session.drain();
