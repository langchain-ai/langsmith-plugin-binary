import { describe, expect, it } from "vitest";
import { createRunIdentity } from "./identity.js";

const PARENT_ID = "11111111-1111-4111-8111-111111111111";
const CHILD_ID = "22222222-2222-4222-8222-222222222222";
const TRACE_ID = "00000000-0000-4000-8000-000000000000";
const START_TIME = "2026-10-10T12:00:00.000Z";

describe("canonical run identity", () => {
  it("formats a root run identity", () => {
    expect(createRunIdentity({ id: PARENT_ID, start_time: START_TIME })).toEqual({
      id: PARENT_ID,
      start_time: START_TIME,
      trace_id: PARENT_ID,
      dotted_order: `20261010T120000000001Z${PARENT_ID}`,
    });
  });

  it("carries canonical parent lineage to a child", () => {
    const parent = {
      id: PARENT_ID,
      parent_run_id: TRACE_ID,
      trace_id: TRACE_ID,
      dotted_order: `20261010T115959000000Z${TRACE_ID}.20261010T120000000000Z${PARENT_ID}`,
    };

    const child = {
      id: CHILD_ID,
      start_time: "2026-10-10T12:00:00.001Z",
      parent_run_id: PARENT_ID,
      trace_id: TRACE_ID,
      dotted_order: `${parent.dotted_order}.20261010T120000001001Z${CHILD_ID}`,
    };
    expect(createRunIdentity({ id: CHILD_ID, start_time: child.start_time, parent })).toEqual(
      child,
    );
    expect(
      createRunIdentity({
        id: CHILD_ID,
        start_time: child.start_time,
        parent: { ...parent, start_time: START_TIME },
      }),
    ).toEqual(child);
  });

  it("preserves nested ancestry when the parent identity omits optional fields", () => {
    const rootOrder = `20261010T115959000000Z${TRACE_ID}`;
    const parent = {
      id: PARENT_ID,
      trace_id: TRACE_ID,
      dotted_order: `${rootOrder}.20261010T120000000000Z${PARENT_ID}`,
    };

    expect(
      createRunIdentity({
        id: CHILD_ID,
        start_time: "2026-10-10T12:00:00.001Z",
        parent,
      }),
    ).toEqual({
      id: CHILD_ID,
      start_time: "2026-10-10T12:00:00.001Z",
      parent_run_id: PARENT_ID,
      trace_id: TRACE_ID,
      dotted_order: `${parent.dotted_order}.20261010T120000001001Z${CHILD_ID}`,
    });
  });

  it("rejects a parent with inconsistent ancestry", () => {
    const parent = createRunIdentity({ id: PARENT_ID, start_time: START_TIME });
    const malformed = { ...parent, parent_run_id: CHILD_ID };
    const parentWithoutStartTime = {
      id: parent.id,
      trace_id: parent.trace_id,
      dotted_order: parent.dotted_order,
    };

    expect(() =>
      createRunIdentity({ id: CHILD_ID, start_time: START_TIME, parent: malformed }),
    ).toThrow("Parent run identity is not canonical");
    expect(() =>
      createRunIdentity({
        id: CHILD_ID,
        start_time: START_TIME,
        parent: {
          ...parentWithoutStartTime,
          dotted_order: parent.dotted_order.replace("20261010", "20261310"),
        },
      }),
    ).toThrow("Parent run identity is not canonical");
    expect(() =>
      createRunIdentity({
        id: CHILD_ID,
        start_time: START_TIME,
        parent: { ...parent, start_time: "2026-10-10T12:01:00.000Z" },
      }),
    ).toThrow("Parent run identity is not canonical");
  });

  it("rejects invalid run timestamps", () => {
    expect(() => createRunIdentity({ id: PARENT_ID, start_time: "invalid" })).toThrow(
      "Run timestamp must be a valid date or millisecond time",
    );
    const parent = createRunIdentity({ id: PARENT_ID, start_time: START_TIME });
    expect(() =>
      createRunIdentity({
        id: CHILD_ID,
        start_time: START_TIME,
        parent: { ...parent, start_time: "invalid" },
      }),
    ).toThrow("Run timestamp must be a valid date or millisecond time");
  });
});
