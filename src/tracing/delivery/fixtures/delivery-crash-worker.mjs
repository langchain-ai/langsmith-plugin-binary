const { createDeliveryCoordinator } = await import(process.argv[2]);
const { writeFileSync } = await import("node:fs");
const c = createDeliveryCoordinator({
  storageRoot: process.argv[3],
  integration: "claude-code",
  sessionId: "session-1",
});
await c.drain({
  writer: {
    accountFingerprint: "account-a",
    destinations: [{ id: "primary" }],
    send: async (record) => {
      writeFileSync(process.argv[4], record.runId);
      process.exit(71);
    },
  },
});
