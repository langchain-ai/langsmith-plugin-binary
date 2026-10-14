import { lstatSync, readFileSync, readdirSync } from "node:fs";

export function diagnose(lockPath) {
  const info = {};
  try {
    const gate = lstatSync(lockPath + ".lock");
    info.gate = { directory: gate.isDirectory(), ageMs: Date.now() - gate.mtimeMs };
    try {
      info.owner = readFileSync(lockPath + ".lock/owner", "utf8");
      info.ownerAgeMs = Date.now() - lstatSync(lockPath + ".lock/owner").mtimeMs;
      try {
        process.kill(Number(info.owner), 0);
        info.ownerAlive = true;
      } catch (error) {
        info.ownerAlive = false;
        info.killCode = error.code;
      }
    } catch (error) {
      info.ownerError = error.code;
    }
  } catch (error) {
    info.gate = error.code;
  }
  try {
    info.claims = readdirSync(lockPath + ".claims");
  } catch (error) {
    info.claims = error.code;
  }
  return JSON.stringify(info);
}
