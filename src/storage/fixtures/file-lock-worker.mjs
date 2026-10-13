const { existsSync, mkdirSync, rmdirSync, writeFileSync } = await import("node:fs");
const { setTimeout: delay } = await import("node:timers/promises");
const api = await import(process.argv[2]);
const [mode, lockPath, marker, gate, timeout, , activePath, startPath] = process.argv.slice(3);
if (mode === "hold") {
  await api.withFileLock(
    lockPath,
    async () => {
      writeFileSync(marker, "held");
      while (!existsSync(gate)) await delay(5);
    },
    { timeoutMs: Number(timeout) },
  );
} else if (mode === "timeout") {
  try {
    await api.withFileLock(lockPath, async () => writeFileSync(marker, "ran"), {
      timeoutMs: Number(timeout),
    });
    process.exitCode = 2;
  } catch (error) {
    process.exitCode = String(error).includes("Timed out waiting for file lock") ? 0 : 3;
  }
} else if (mode === "try") {
  const handle = await api.tryAcquireFileLock(lockPath);
  writeFileSync(marker, handle ? "owned" : "busy");
  if (handle) await handle.release();
} else if (mode === "queue") {
  writeFileSync(marker + ".ready", "ready");
  if (startPath) {
    while (!existsSync(startPath)) await delay(5);
  }
  try {
    await api.withFileLock(
      lockPath,
      async () => {
        try {
          mkdirSync(activePath);
        } catch {
          writeFileSync(marker + ".violation", "overlap");
          throw new Error("overlapping critical sections");
        }
        writeFileSync(marker + ".acquired", "acquired");
        while (!existsSync(gate)) await delay(5);
        rmdirSync(activePath);
        writeFileSync(marker + ".complete", "complete");
      },
      { timeoutMs: Number(timeout) },
    );
    writeFileSync(marker + ".released", "released");
  } catch (error) {
    writeFileSync(marker + ".failed", String(error.stack ?? error));
    process.exitCode = 4;
  }
} else if (mode === "race") {
  writeFileSync(marker + ".ready", "ready");
  while (!existsSync(startPath)) await delay(1);
  const handle = await api.tryAcquireFileLock(lockPath);
  writeFileSync(marker, handle ? "owned" : "busy");
  if (handle) {
    while (!existsSync(gate)) await delay(5);
    await handle.release();
  }
} else if (mode === "gate") {
  writeFileSync(marker + ".ready", "ready");
  while (!existsSync(startPath)) await delay(1);
  let outcome = "ok";
  try {
    const handle = await api.acquireCompatibleDirectoryFileLock(lockPath, { timeoutMs: 20000 });
    try {
      mkdirSync(activePath);
      await delay(10);
      rmdirSync(activePath);
    } catch {
      outcome = "overlap";
    }
    await handle.release();
  } catch (error) {
    outcome = String(error);
  }
  writeFileSync(marker, outcome);
} else if (mode === "die") {
  const handle = await api.tryAcquireFileLock(lockPath);
  if (!handle) process.exit(5);
  writeFileSync(marker, "owned");
  for (;;) await delay(1000);
}
