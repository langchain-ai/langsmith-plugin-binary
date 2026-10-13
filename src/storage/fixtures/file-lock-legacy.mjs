const { existsSync, mkdirSync, rmdirSync, writeFileSync } = await import("node:fs");
const { setTimeout: delay } = await import("node:timers/promises");
const [gate, marker, startPath, activePath] = process.argv.slice(2);
writeFileSync(marker + ".ready", "ready");
while (!existsSync(startPath)) await delay(1);
let outcome = "ok";
for (let round = 0; round < 5; round += 1) {
  for (;;) {
    try {
      mkdirSync(gate);
      break;
    } catch {
      await delay(1);
    }
  }
  try {
    mkdirSync(activePath);
    await delay(10);
    rmdirSync(activePath);
  } catch {
    outcome = "overlap";
  }
  rmdirSync(gate);
}
writeFileSync(marker, outcome);
