const [renewalUrl, launcherUrl, configPath, log, startAt, path, tokenHash, stateRoot] =
  process.argv.slice(2);
const { renewRejectedLogin } = await import(renewalUrl);
const { setDesktopLauncherForTests } = await import(launcherUrl);
const { appendFileSync, writeSync } = await import("node:fs");
setDesktopLauncherForTests((command, _args, _env, output) => {
  appendFileSync(log, `${command}\n`);
  if (output !== undefined) writeSync(output, "Enter code: RACE-CODE\n");
  return 1;
});
console.warn = () => undefined;
while (Date.now() < Number(startAt));
const login = { configPath, profile: "work" };
const options = {
  env: { PATH: path, DISPLAY: ":0" },
  storageRoot: stateRoot,
  platform: "linux",
  cliFolders: [],
};
await renewRejectedLogin(login, "https://login.example", tokenHash, options);
