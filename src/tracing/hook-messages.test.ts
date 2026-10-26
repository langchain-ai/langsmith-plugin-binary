import { expect, it } from "vitest";
import { hookMessage, hookMetadata } from "./index.js";

it("formats a hook's output as a named system message", () => {
  expect(hookMessage({ name: "UserPromptSubmit", text: "Run the linter", id: "hook-1" })).toEqual({
    role: "system",
    name: "UserPromptSubmit",
    id: "hook-1",
    content: "UserPromptSubmit: Run the linter",
  });
});

it("counts hooks by name and adds nothing when no hook ran", () => {
  expect(hookMetadata([])).toEqual({});
  expect(
    hookMetadata([{ name: "PostToolUse" }, { name: "UserPromptSubmit" }, { name: "PostToolUse" }]),
  ).toEqual({ ls_hooks: { PostToolUse: 2, UserPromptSubmit: 1 } });
  expect(
    hookMetadata([{ name: "__proto__" }, { name: "constructor" }, { name: "constructor" }]),
  ).toEqual({ ls_hooks: { ["__proto__"]: 1, constructor: 2 } });
});
