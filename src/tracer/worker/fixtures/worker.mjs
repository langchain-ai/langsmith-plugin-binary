const fs = await import("node:fs");
const dist = process.argv[2];
const { runWorker } = await import(`${dist}/worker/worker.js`);
const { readNewLines } = await import(`${dist}/reader/reader.js`);
const { tracerPaths } = await import(`${dist}/paths.js`);
const { stateFolder, record, version } = JSON.parse(process.argv[3]);
const paths = tracerPaths(stateFolder);
const write = (entry) => fs.appendFileSync(record, `${entry}\n`);

function injectWrite(bookmark) {
  const injection = `${bookmark.path}.inject`;
  if (!fs.existsSync(injection)) return;
  const { path, text } = JSON.parse(fs.readFileSync(injection, "utf8"));
  fs.appendFileSync(path, text);
  fs.unlinkSync(injection);
}

await runWorker({
  paths,
  version,
  upgradeState: () =>
    fs.appendFileSync(`${record}.upgrades`, `notes waiting: ${fs.existsSync(paths.notes)}\n`),
  readNewLines: (bookmark, lineId) => {
    injectWrite(bookmark);
    return readNewLines(bookmark, lineId).lines;
  },
  createBuilder: ({ sessionId }) => {
    const subagents = new Set();
    return {
      lineId: (line) => line.uuid,
      readLine: (path, line) => {
        write(`${sessionId} line ${line.uuid}`);
        if (line.subagent) subagents.add(line.subagent);
        if (line.fillsQueue) fs.writeFileSync(`${record}.full`, "");
      },
      receiveNote: (note) => write(`${sessionId} note ${note.event}`),
      transcripts: () => [...subagents],
      state: () => ({}),
    };
  },
  createQueue: () => ({
    post: () => undefined,
    patch: () => undefined,
    pendingFor: () => (fs.existsSync(`${record}.pending`) ? 1 : 0),
    idle: () => true,
    full: () => fs.existsSync(`${record}.full`),
    flush: () => undefined,
  }),
  snapshots: {
    load: () =>
      fs.existsSync(paths.snapshot)
        ? JSON.parse(fs.readFileSync(paths.snapshot, "utf8"))
        : undefined,
    save: (snapshot) => fs.writeFileSync(paths.snapshot, JSON.stringify(snapshot)),
  },
});
process.exit(0);
