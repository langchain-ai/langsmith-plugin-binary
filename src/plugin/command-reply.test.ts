import { describe, expect, it } from "vitest";
import { commandReplyContext } from "./index.js";

describe("the context a command turn hands the model", () => {
  it("starts with the marker hook readers skip and ends with the reply", () => {
    expect(commandReplyContext("Thread tracing muted.")).toBe(
      "[LangSmith tracing command] The user ran a LangSmith tracing command and the plugin already handled it. Reply with exactly the text below and nothing else:\n\nThread tracing muted.",
    );
  });
});
