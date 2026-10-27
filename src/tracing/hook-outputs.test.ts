import { expect, it } from "vitest";
import { hookOutputs } from "./index.js";

it("lists hook outputs under one key and adds nothing when no hook ran", () => {
  const sessionStart = { name: "SessionStart", output: "On branch main", toolUseId: "toolu_1" };
  expect(hookOutputs([])).toEqual({});
  expect(
    hookOutputs([{ name: "UserPromptSubmit", output: "Run the linter" }, sessionStart]),
  ).toEqual({
    hooks: [
      { name: "UserPromptSubmit", output: "Run the linter" },
      { name: "SessionStart", output: "On branch main" },
    ],
  });
});
