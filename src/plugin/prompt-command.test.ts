import { expect, it } from "vitest";
import { matchPromptCommand, promptCommandResponse, runPromptCommand } from "./index.js";

const context = (reply: string) =>
  `[LangSmith tracing command] The user ran a LangSmith tracing command and the plugin already did what they asked. Let them know what happened, based on the result below:\n\n${reply}`;

const commands = [
  { name: "mute", text: "/tool:mute", takesArguments: false },
  { name: "setup", text: "/tool:setup", takesArguments: true },
] as const;

it("matches a command exactly, or by its name and then arguments when it takes them", () => {
  expect(matchPromptCommand("/tool:mute", commands)).toEqual({ name: "mute", argumentText: "" });
  expect(matchPromptCommand("/tool:setup demo", commands)).toEqual({
    name: "setup",
    argumentText: " demo",
  });
  expect(matchPromptCommand("/tool:setup\ndemo", commands)).toEqual({
    name: "setup",
    argumentText: "\ndemo",
  });
  for (const prompt of ["/tool:mute now", "/tool:setupx", "please /tool:mute"]) {
    expect(matchPromptCommand(prompt, commands)).toBeUndefined();
  }
});

it("lets the prompt through with the reply, or blocks it when strict auth refused the turn", () => {
  expect(
    promptCommandResponse("Muted.", { systemMessages: ["Login expired.", "Sign in."] }),
  ).toEqual({
    systemMessage: "Login expired.\nSign in.",
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context("Muted."),
    },
  });
  expect(
    promptCommandResponse("Muted. Sign in.", { systemMessages: ["Login expired.", "Sign in."] }),
  ).toEqual({
    systemMessage: "Login expired.",
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: context("Muted. Sign in."),
    },
  });
  expect(promptCommandResponse("Muted.", {})).toEqual({
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context("Muted.") },
  });
  expect(promptCommandResponse("Muted.", { blockReason: "Sign in." })).toEqual({
    decision: "block",
    reason: "Muted.\n\nSign in.",
  });
  expect(promptCommandResponse("Muted. Sign in.", { blockReason: "Sign in." })).toEqual({
    decision: "block",
    reason: "Muted. Sign in.",
  });
});

it("runs the matched command's handler and turns a failure into the reply", async () => {
  const handlers = {
    mute: () => "Muted.",
    setup: (argumentText: string, cwd: string) => {
      throw new Error(`No setup${argumentText} in ${cwd}`);
    },
  };
  expect(await runPromptCommand({ name: "mute", argumentText: "" }, handlers, "/repo")).toBe(
    "Muted.",
  );
  expect(await runPromptCommand({ name: "setup", argumentText: " demo" }, handlers, "/repo")).toBe(
    "No setup demo in /repo",
  );
});
