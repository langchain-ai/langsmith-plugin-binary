import * as api from "../index.ts";

const id = "11111111-1111-4111-8111-111111111111";
const writer = api.createLangSmithUploadWriter({
  redact: false,
  destinations: [{ apiKey: "synthetic-key", apiUrl: process.argv.at(-1), projectName: "p" }],
});
await writer.send(
  {
    operation: "post",
    integration: "claude-code",
    privacyMode: "full",
    metadata: { integration: "claude-code", threadId: "t", agentType: "root", runType: "root" },
    run: {
      id,
      name: "run",
      run_type: "chain",
      start_time: "2026-10-10T12:00:00.000Z",
      trace_id: id,
      dotted_order: `20261010T120000000000Z${id}`,
      inputs: { large: "x".repeat(80_000) },
    },
  },
  writer.destinations[0].id,
);
