import { describe, expect, it } from "vitest";
import {
  ACTIVITY_CATEGORIES,
  AUDIT_ACTION_VALUES,
  AUDIT_ACTIONS,
  EVENT_TYPES,
  IMPERSONATION_END_REASONS,
  IMPERSONATION_SESSION_ACTION,
  actionsOfCategory,
  activityCategory,
  impersonationEndAction,
  impersonationEndSource,
} from "./activity";

describe("activity catalogs", () => {
  it("has no duplicate names", () => {
    expect(new Set(AUDIT_ACTION_VALUES).size).toBe(AUDIT_ACTION_VALUES.length);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    for (const action of AUDIT_ACTION_VALUES) {
      expect(EVENT_TYPES).not.toContain(action);
    }
  });

  it("gives every event type and audit action a real category", () => {
    for (const type of EVENT_TYPES) {
      expect(activityCategory("event", type)).not.toBe("other");
    }
    for (const action of AUDIT_ACTION_VALUES) {
      expect(activityCategory("audit", action)).not.toBe("other");
    }
    expect(
      activityCategory("impersonation", IMPERSONATION_SESSION_ACTION),
    ).toBe("access");
  });

  it("falls back to other for unknown actions", () => {
    expect(activityCategory("event", "something_new")).toBe("other");
    expect(activityCategory("audit", "something.new")).toBe("other");
    expect(activityCategory("event", "constructor")).toBe("other");
    expect(activityCategory("audit", "toString")).toBe("other");
    // An audit action is not an event type, and the other way round.
    expect(activityCategory("event", AUDIT_ACTIONS.ROLE_ASSIGN)).toBe("other");
  });

  it("splits the catalogs into categories without loss", () => {
    const eventTypes = ACTIVITY_CATEGORIES.flatMap(
      (category) => actionsOfCategory(category).eventTypes,
    );
    const auditActions = ACTIVITY_CATEGORIES.flatMap(
      (category) => actionsOfCategory(category).auditActions,
    );
    expect([...eventTypes].sort()).toEqual([...EVENT_TYPES].sort());
    expect([...auditActions].sort()).toEqual([...AUDIT_ACTION_VALUES].sort());
    expect(actionsOfCategory("access").auditActions).toContain(
      AUDIT_ACTIONS.AUTH_SIGN_IN,
    );
    expect(actionsOfCategory("amendment").eventTypes).toContain(
      "position_changed",
    );
  });

  it("records each impersonation end with its action and source", () => {
    expect(IMPERSONATION_END_REASONS.map(impersonationEndAction)).toEqual([
      "impersonation.stop",
      "impersonation.expire",
      "impersonation.stop",
      "impersonation.revoke",
    ]);
    expect(IMPERSONATION_END_REASONS.map(impersonationEndSource)).toEqual([
      "user",
      "system",
      "auth",
      "system",
    ]);
  });
});
