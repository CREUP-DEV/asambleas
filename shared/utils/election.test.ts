import { describe, expect, it } from "vitest";
import { computeElectionOutcome, electionWithPosts } from "./election";

const valid = { denominator: "valid_votes" } as const;
const none = { blank: 0, invalid: 0, present: null };

describe("computeElectionOutcome", () => {
  it("elects whoever reaches the absolute majority in the first round", () => {
    expect(
      computeElectionOutcome(
        {
          counts: [12, 8],
          ballots: 20,
          posts: 1,
          rule: "absolute_runoff",
        },
        none,
        valid,
      ),
    ).toMatchObject({ elected: [0], runoff: null, threshold: 11 });
  });

  it("sends the two most voted to a second round when nobody reaches it", () => {
    expect(
      computeElectionOutcome(
        {
          counts: [8, 7, 5],
          ballots: 20,
          posts: 1,
          rule: "absolute_runoff",
        },
        none,
        valid,
      ),
    ).toMatchObject({ elected: [], runoff: [0, 1], tie: false });
  });

  it("counts blank ballots among the votes cast", () => {
    // 10 + 9 marked, 2 blank: 21 cast, 11 needed.
    expect(
      computeElectionOutcome(
        {
          counts: [10, 9],
          ballots: 19,
          posts: 1,
          rule: "absolute_runoff",
        },
        { blank: 2, invalid: 3, present: null },
        valid,
      ),
    ).toMatchObject({ elected: [], runoff: [0, 1], denominator: 21 });
  });

  it("elects the most voted under a simple majority, several posts", () => {
    expect(
      computeElectionOutcome(
        { counts: [3, 9, 6, 1], ballots: 10, posts: 2, rule: "simple" },
        none,
        valid,
      ),
    ).toMatchObject({ elected: [1, 2], runoff: null, tie: false });
  });

  it("leaves a tie at the last post to the Mesa", () => {
    expect(
      computeElectionOutcome(
        { counts: [9, 6, 6], ballots: 10, posts: 2, rule: "simple" },
        none,
        valid,
      ),
    ).toMatchObject({ elected: [0], tie: true });
  });

  it("flags more ballots than members present", () => {
    expect(
      computeElectionOutcome(
        { counts: [5, 5], ballots: 10, posts: 1, rule: "simple" },
        { blank: 1, invalid: 1, present: 11 },
        valid,
      ).inconsistent,
    ).toBe(true);
  });
});

describe("computeElectionOutcome with posts apart from the marks per ballot", () => {
  it("fills the posts, not the marks a ballot may make", () => {
    // Two posts, one mark per ballot: the two most voted.
    expect(
      computeElectionOutcome(
        { counts: [9, 6, 3], ballots: 18, posts: 2, rule: "simple" },
        none,
        valid,
      ),
    ).toMatchObject({ elected: [0, 1], tie: false });
  });

  it("sends twice the posts left to a second round", () => {
    // 20 cast, 11 needed: one elected, the one post left goes to the two
    // next most voted.
    expect(
      computeElectionOutcome(
        {
          counts: [12, 5, 2, 1],
          ballots: 20,
          posts: 2,
          rule: "absolute_runoff",
        },
        none,
        valid,
      ),
    ).toMatchObject({ elected: [0], runoff: [1, 2] });
  });
});

describe("electionWithPosts", () => {
  const stored = {
    candidates: ["A", "B"],
    maxChoices: 2,
    rule: "simple" as const,
    counts: [3, 2],
    ballots: 4,
    elected: [0, 1],
    runoff: null,
    tie: false,
  };

  it("reads an election stored before posts as its marks per ballot", () => {
    expect(electionWithPosts(stored).posts).toBe(2);
  });

  it("keeps the posts of one that has them", () => {
    expect(electionWithPosts({ ...stored, posts: 1 }).posts).toBe(1);
  });
});
