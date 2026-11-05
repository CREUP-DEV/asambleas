import { describe, expect, it, vi } from "vitest";

// Only the pure rule is tested here: the loaders need the database.
vi.mock("../../db", () => ({ db: {} }));

const { planPresenters, presentersChanged } = await import("./presenters");

const create = (
  input: Partial<Parameters<typeof planPresenters>[0]> = {},
): ReturnType<typeof planPresenters> =>
  planPresenters({
    manager: false,
    actorMemberId: "own",
    current: null,
    proponentMemberId: undefined,
    coProponentMemberIds: undefined,
    ...input,
  });

const update = (
  current: { proponentMemberId: string | null; coProponentMemberIds: string[] },
  input: Partial<Parameters<typeof planPresenters>[0]> = {},
): ReturnType<typeof planPresenters> =>
  planPresenters({
    manager: false,
    actorMemberId: "own",
    proponentMemberId: undefined,
    coProponentMemberIds: undefined,
    ...input,
    current,
  });

describe("planPresenters on create", () => {
  it("makes a member the presenter of its own document", () => {
    expect(create()).toEqual({
      proponentMemberId: "own",
      coProponentMemberIds: [],
    });
    expect(create({ proponentMemberId: null })).toEqual({
      proponentMemberId: "own",
      coProponentMemberIds: [],
    });
  });

  it("asks for the main presenter when there are co-presenters", () => {
    expect(create({ coProponentMemberIds: ["b"] })).toBe("main_required");
    expect(create({ coProponentMemberIds: ["own"] })).toEqual({
      proponentMemberId: "own",
      coProponentMemberIds: [],
    });
  });

  it("lets a member pick the main presenter among them, its own included", () => {
    expect(
      create({ coProponentMemberIds: ["b"], proponentMemberId: "b" }),
    ).toEqual({ proponentMemberId: "b", coProponentMemberIds: ["own"] });
    expect(
      create({ coProponentMemberIds: ["b"], proponentMemberId: "own" }),
    ).toEqual({ proponentMemberId: "own", coProponentMemberIds: ["b"] });
  });

  it("takes the body as the contract sends it: the main one apart", () => {
    // The member adds b and makes it the main presenter: b is not listed
    // among the co-presenters, its own member is.
    expect(
      create({ coProponentMemberIds: ["own"], proponentMemberId: "b" }),
    ).toEqual({ proponentMemberId: "b", coProponentMemberIds: ["own"] });
    expect(
      create({ coProponentMemberIds: ["own", "c"], proponentMemberId: "b" }),
    ).toEqual({ proponentMemberId: "b", coProponentMemberIds: ["own", "c"] });
    // Its own member joins even when the body leaves it out.
    expect(create({ proponentMemberId: "b" })).toEqual({
      proponentMemberId: "b",
      coProponentMemberIds: ["own"],
    });
    expect(create({ coProponentMemberIds: ["b", "c"] })).toBe("main_required");
  });

  it("lets managers set anyone, defaulting to their own member", () => {
    expect(create({ manager: true, actorMemberId: "sec" })).toEqual({
      proponentMemberId: "sec",
      coProponentMemberIds: [],
    });
    expect(
      create({
        manager: true,
        proponentMemberId: "a",
        coProponentMemberIds: ["a", "b"],
      }),
    ).toEqual({ proponentMemberId: "a", coProponentMemberIds: ["b"] });
    expect(
      create({ manager: true, actorMemberId: null, proponentMemberId: null }),
    ).toEqual({ proponentMemberId: null, coProponentMemberIds: [] });
    expect(
      create({
        manager: true,
        actorMemberId: null,
        coProponentMemberIds: ["b"],
      }),
    ).toBe("main_required");
  });
});

describe("planPresenters on update", () => {
  const current = { proponentMemberId: "own", coProponentMemberIds: ["b"] };

  it("keeps what the body leaves out", () => {
    expect(update(current)).toEqual(current);
    expect(update(current, { coProponentMemberIds: ["c"] })).toEqual({
      proponentMemberId: "own",
      coProponentMemberIds: ["c"],
    });
  });

  it("keeps the former main presenter when another presenter takes over", () => {
    expect(update(current, { proponentMemberId: "b" })).toEqual({
      proponentMemberId: "b",
      coProponentMemberIds: ["own"],
    });
  });

  it("does not let a member leave its own document", () => {
    expect(update(current, { coProponentMemberIds: [] })).toEqual({
      proponentMemberId: "own",
      coProponentMemberIds: [],
    });
    expect(
      update(
        { proponentMemberId: "a", coProponentMemberIds: ["own"] },
        { coProponentMemberIds: [] },
      ),
    ).toBe("own_member_required");
    expect(
      update(current, { proponentMemberId: "z", coProponentMemberIds: ["b"] }),
    ).toBe("own_member_required");
  });

  it("lets a member hand the main role to a new presenter", () => {
    // As the form sends it: the new main one apart, everyone else listed.
    expect(
      update(current, {
        proponentMemberId: "z",
        coProponentMemberIds: ["own", "b"],
      }),
    ).toEqual({ proponentMemberId: "z", coProponentMemberIds: ["own", "b"] });
    // Without the co-presenters, nobody drops out: the former main one stays.
    expect(update(current, { proponentMemberId: "z" })).toEqual({
      proponentMemberId: "z",
      coProponentMemberIds: ["b", "own"],
    });
    expect(
      update(
        { proponentMemberId: "a", coProponentMemberIds: ["own"] },
        { proponentMemberId: "z" },
      ),
    ).toEqual({ proponentMemberId: "z", coProponentMemberIds: ["own", "a"] });
  });

  it("lets managers replace the main presenter", () => {
    expect(update(current, { manager: true, proponentMemberId: "z" })).toEqual({
      proponentMemberId: "z",
      coProponentMemberIds: ["b"],
    });
    expect(update(current, { manager: true, proponentMemberId: null })).toBe(
      "main_required",
    );
  });
});

describe("presentersChanged", () => {
  it("compares the co-presenters in any order", () => {
    const a = { proponentMemberId: "a", coProponentMemberIds: ["b", "c"] };
    expect(
      presentersChanged(a, { ...a, coProponentMemberIds: ["c", "b"] }),
    ).toBe(false);
    expect(presentersChanged(a, { ...a, coProponentMemberIds: ["b"] })).toBe(
      true,
    );
    expect(presentersChanged(a, { ...a, proponentMemberId: "b" })).toBe(true);
  });
});
