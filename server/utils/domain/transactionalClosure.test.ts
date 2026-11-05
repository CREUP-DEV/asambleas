import { describe, expect, it, vi } from "vitest";

// Only the pure planner is tested here: closing needs the database.
vi.mock("../../db", () => ({ db: {} }));
vi.mock("./events", () => ({ recordEvent: vi.fn() }));

const { buildSourceMap, competingTransactionalIds, transactionalsToClose } =
  await import("./transactionalClosure");

describe("transactionalsToClose", () => {
  // T1 groups A and B, T2 groups B, T3 groups C, T4 groups T1 (it replaced
  // its sources, so it can be grouped).
  const sourceMap = buildSourceMap([
    { transactionalId: "t1", sourceId: "a" },
    { transactionalId: "t1", sourceId: "b" },
    { transactionalId: "t2", sourceId: "b" },
    { transactionalId: "t3", sourceId: "c" },
    { transactionalId: "t4", sourceId: "t1" },
  ]);
  const submitted = (id: string) => ({ id, status: "submitted" as const });

  it("closes the pending transactionals over a settled amendment", () => {
    const candidates = competingTransactionalIds(sourceMap, null, ["b"]).map(
      submitted,
    );
    expect(transactionalsToClose(sourceMap, ["b"], candidates)).toEqual([
      { id: "t1", sourceId: "b" },
      { id: "t2", sourceId: "b" },
    ]);
  });

  it("names the first settled amendment each one groups", () => {
    expect(
      transactionalsToClose(sourceMap, ["b", "a"], [submitted("t1")]),
    ).toEqual([{ id: "t1", sourceId: "a" }]);
  });

  it("closes a transactional over another one that was settled", () => {
    expect(transactionalsToClose(sourceMap, ["t1"], [submitted("t4")])).toEqual(
      [{ id: "t4", sourceId: "t1" }],
    );
  });

  it("leaves alone what is no longer submitted or groups nothing settled", () => {
    expect(
      transactionalsToClose(
        sourceMap,
        ["b"],
        [
          { id: "t1", status: "withdrawn" },
          { id: "t2", status: "lapsed" },
          submitted("t3"),
        ],
      ),
    ).toEqual([]);
  });

  it("never closes the amendments being settled themselves", () => {
    // Declaring T1 and B inadmissible at once: T1 is settled, not closed.
    expect(
      transactionalsToClose(
        sourceMap,
        ["t1", "b"],
        [submitted("t1"), submitted("t2"), submitted("t4")],
      ),
    ).toEqual([
      { id: "t2", sourceId: "b" },
      { id: "t4", sourceId: "t1" },
    ]);
  });

  it("lists each transactional once", () => {
    expect(
      transactionalsToClose(
        sourceMap,
        ["a", "b"],
        [submitted("t1"), submitted("t1")],
      ),
    ).toEqual([{ id: "t1", sourceId: "a" }]);
  });
});
