import { describe, expect, it } from "vitest";
import { AMENDMENT_STATUSES } from "~~/shared/constants/domain";
import { XLSX_CELL_STYLES } from "~~/shared/utils/xlsx";
import {
  LIVE_AMENDMENT_STATES,
  type LiveAmendmentState,
} from "~/components/live-view/-model";
import {
  amendmentStateCellStyle,
  resultCellStyle,
} from "~/components/control-sheet/-export";
import {
  CONTROL_SHEET_RESULT_COLORS,
  CONTROL_SHEET_STATE_COLORS,
  LIVE_STATE_COLORS,
  PROJECTION_STATE_COLORS,
  SESSION_STAGE_COLORS,
  STATUS_COLORS,
  XLSX_STYLE_OF_COLOR,
  statusColor,
  statusLabelKey,
  type StatusColor,
} from "./statusColors";
import { OUTCOME_TEXT, STATUS_DOT } from "./statusTone";

const COLORS: readonly StatusColor[] = [
  "primary",
  "secondary",
  "success",
  "info",
  "warning",
  "error",
  "neutral",
];

describe("STATUS_COLORS", () => {
  it("gives every amendment status a colour", () => {
    for (const status of AMENDMENT_STATUSES) {
      expect(COLORS).toContain(STATUS_COLORS.amendment[status]);
    }
  });

  it("falls back to neutral for an unknown value", () => {
    expect(statusColor("amendment", "transacted")).toBe("secondary");
    expect(statusColor("amendment", "nonsense")).toBe("neutral");
  });

  it("keys a label under common.status", () => {
    expect(statusLabelKey("amendment", "lapsed")).toBe(
      "common.status.amendment.lapsed",
    );
  });
});

describe("LIVE_STATE_COLORS", () => {
  it("gives every live state a colour", () => {
    for (const state of LIVE_AMENDMENT_STATES) {
      expect(COLORS).toContain(LIVE_STATE_COLORS[state]);
    }
  });

  it("paints a decided state as its status badge", () => {
    for (const state of LIVE_AMENDMENT_STATES) {
      if (!(AMENDMENT_STATUSES as readonly string[]).includes(state)) continue;
      expect(LIVE_STATE_COLORS[state]).toBe(
        STATUS_COLORS.amendment[state as keyof typeof STATUS_COLORS.amendment],
      );
    }
  });
});

describe("the control sheet", () => {
  it("overrides only pending (amber) and lapsed (grey)", () => {
    for (const state of LIVE_AMENDMENT_STATES) {
      const expected =
        state === "pending"
          ? "warning"
          : state === "lapsed"
            ? "neutral"
            : LIVE_STATE_COLORS[state];
      expect(CONTROL_SHEET_STATE_COLORS[state]).toBe(expected);
    }
  });

  it("writes the same Excel cells as before the one map", () => {
    // The switch amendmentStateCellStyle had until ARQ-15.
    const before: Record<LiveAmendmentState, string> = {
      debating: "info",
      pending: "warning",
      late: "warning",
      approved: "success",
      incorporated: "success",
      rejected: "danger",
      transacted: "info",
      turned_down: "neutral",
      withdrawn: "neutral",
      lapsed: "neutral",
      inadmissible: "danger",
    };
    for (const state of LIVE_AMENDMENT_STATES) {
      expect(amendmentStateCellStyle(state)).toBe(before[state]);
    }
    expect(resultCellStyle(null)).toBe("warning");
    expect(resultCellStyle("approved")).toBe("success");
    expect(resultCellStyle("approved_unanimous")).toBe("success");
    expect(resultCellStyle("rejected")).toBe("danger");
    expect(resultCellStyle("mixed")).toBe("info");
    for (const result of [
      "withdrawn",
      "lapsed",
      "postponed",
      "not_applicable",
    ] as const) {
      expect(resultCellStyle(result)).toBe("neutral");
      expect(CONTROL_SHEET_RESULT_COLORS[result]).toBe("neutral");
    }
  });

  it("maps every colour to an Excel cell style", () => {
    for (const color of COLORS) {
      expect(XLSX_CELL_STYLES).toContain(XLSX_STYLE_OF_COLOR[color]);
    }
  });
});

describe("PROJECTION_STATE_COLORS", () => {
  it("writes the same result text as before the one map", () => {
    // stateClass in ProjectionAmendments until ARQ-15.
    const before: Partial<Record<LiveAmendmentState, string>> = {
      approved: OUTCOME_TEXT.success,
      incorporated: OUTCOME_TEXT.success,
      rejected: OUTCOME_TEXT.error,
      inadmissible: OUTCOME_TEXT.error,
      late: OUTCOME_TEXT.warning,
    };
    for (const state of LIVE_AMENDMENT_STATES) {
      const color = PROJECTION_STATE_COLORS[state];
      const text =
        color in OUTCOME_TEXT
          ? OUTCOME_TEXT[color as keyof typeof OUTCOME_TEXT]
          : "text-dimmed";
      expect(text).toBe(before[state] ?? "text-dimmed");
    }
  });
});

describe("SESSION_STAGE_COLORS", () => {
  it("paints a status stage as its badge, but lapsed grey", () => {
    for (const status of AMENDMENT_STATUSES) {
      if (status === "submitted") continue;
      expect(SESSION_STAGE_COLORS[status]).toBe(
        status === "lapsed" ? "neutral" : STATUS_COLORS.amendment[status],
      );
    }
  });

  it("draws the same queue dots as before the one map", () => {
    // STAGE_DOT in QueueRow until ARQ-15.
    const grey = "bg-(--ui-text-dimmed)";
    const before: Record<keyof typeof SESSION_STAGE_COLORS, string> = {
      turned_down: grey,
      closed: grey,
      superseded: "bg-warning",
      awaiting_authors: grey,
      awaiting_validation: grey,
      correction_requested: grey,
      late: "bg-warning",
      sources_admission: "bg-warning",
      acceptances: "bg-warning",
      open: "bg-info",
      incorporated: "bg-success",
      approved: "bg-success",
      rejected: "bg-error",
      inadmissible: "bg-error",
      withdrawn: grey,
      lapsed: grey,
      transacted: "bg-secondary",
      draft: grey,
    };
    for (const [stage, dot] of Object.entries(before)) {
      expect(
        STATUS_DOT[
          SESSION_STAGE_COLORS[stage as keyof typeof SESSION_STAGE_COLORS]
        ],
      ).toBe(dot);
    }
    expect(Object.keys(SESSION_STAGE_COLORS).sort()).toEqual(
      Object.keys(before).sort(),
    );
  });
});
