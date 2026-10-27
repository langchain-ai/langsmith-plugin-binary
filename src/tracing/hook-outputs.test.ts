import { expect, it } from "vitest";
import { hookOutputs } from "./index.js";
import type { HookOutput } from "./index.js";

it("lists hook outputs under one key and adds nothing when no hook ran", () => {
  const sessionStart = { name: "SessionStart", output: "On branch main", toolUseId: "toolu_1" };
  const missingOutput = { name: "PostToolUse" } as unknown as HookOutput;
  expect(hookOutputs([])).toStrictEqual({});
  expect(hookOutputs([missingOutput])).toStrictEqual({});
  expect(
    hookOutputs([
      { name: "UserPromptSubmit", output: "Run the linter" },
      sessionStart,
      missingOutput,
    ]),
  ).toStrictEqual({
    hooks: [
      { name: "UserPromptSubmit", output: "Run the linter" },
      { name: "SessionStart", output: "On branch main" },
    ],
  });
});
