import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { desktopNotificationCommand } from "./notification.js";

const TITLE = "LangSmith tracing";
const MESSAGE = "it's 'quoted' $(not run)";

describe("desktop notification", () => {
  it("hands the text to osascript as arguments on macOS", () => {
    const notifier = desktopNotificationCommand(TITLE, MESSAGE, "darwin", {});
    expect(notifier?.command).toBe("/usr/bin/osascript");
    expect(notifier?.args.slice(-2)).toEqual([MESSAGE, TITLE]);
  });

  it("shows a hidden PowerShell toast on Windows without putting the text in the script", () => {
    const notifier = desktopNotificationCommand(TITLE, MESSAGE, "win32", {});
    expect(notifier?.command).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    const elsewhere = desktopNotificationCommand(TITLE, MESSAGE, "win32", {
      SystemRoot: "D:\\Win",
    });
    expect(elsewhere?.command).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(notifier?.args).toEqual(expect.arrayContaining(["-WindowStyle", "Hidden"]));
    expect(notifier?.args.join(" ")).not.toContain(MESSAGE);
    expect(notifier?.env).toMatchObject({
      LANGSMITH_NOTIFICATION_TITLE: TITLE,
      LANGSMITH_NOTIFICATION_MESSAGE: MESSAGE,
    });
  });

  it.runIf(process.platform === "win32")(
    "runs the PowerShell toast script cleanly",
    () => {
      const notifier = desktopNotificationCommand(TITLE, MESSAGE, "win32", process.env)!;
      const run = spawnSync(notifier.command, notifier.args, {
        env: notifier.env,
        timeout: 30_000,
      });
      expect({ status: run.status, stderr: String(run.stderr) }).toEqual({ status: 0, stderr: "" });
    },
    30_000,
  );

  it("never finds a tool in a relative PATH entry like the current folder", () => {
    const folder = mkdtempSync(join(tmpdir(), "relative tools "));
    writeFileSync(join(folder, "notify-send"), "", { mode: 0o755 });
    const env = { PATH: relative(process.cwd(), folder) };
    expect(desktopNotificationCommand(TITLE, MESSAGE, "linux", env)).toBeUndefined();
  });
});
