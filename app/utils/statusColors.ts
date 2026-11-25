/**
 * The colour of every status, in one place (ARQ-15): the domain statuses
 * (CommonStatusBadge), an amendment's state in the room (Directo, the
 * projection, the control sheet), the console's stages and the control
 * sheet's results. A view never declares its own map: it reads one of these,
 * or one of the named variants below, so changing the colour of a status, or
 * adding one, is one line here and the compiler finds every map it misses.
 * The classes that paint a colour (a dot, a result's text) are in
 * `statusTone.ts`; the badges' and buttons' text on a tint is `ON_TINT`, in
 * `app.config.ts`.
 *
 * Pure: no Vue or Nuxt, tested on its own (statusColors.test.ts). Import it
 * explicitly.
 */
import type {
  AcceptanceDecision,
  AdmissionStatus,
  AmendmentStatus,
  AssemblyStatus,
  DocumentStatus,
  ProponentPosition,
  VoteResult,
} from "~~/shared/constants/domain";
import type { ControlSheetResult } from "~~/shared/utils/controlSheet";
import type { XlsxCellStyle } from "~~/shared/utils/xlsx";
import type { LiveAmendmentState } from "~/components/live-view/-model";
import type { SessionAmendmentStage } from "~/composables/session/sessionModel";

export type StatusKind =
  | "assembly"
  | "document"
  | "amendment"
  | "admission"
  | "position"
  | "vote"
  | "acceptance";

export type StatusColor =
  | "primary"
  | "secondary"
  | "success"
  | "info"
  | "warning"
  | "error"
  | "neutral";

/** Badge colour of every status value, per kind. */
export const STATUS_COLORS: {
  assembly: Record<AssemblyStatus, StatusColor>;
  document: Record<DocumentStatus, StatusColor>;
  amendment: Record<AmendmentStatus, StatusColor>;
  admission: Record<AdmissionStatus, StatusColor>;
  position: Record<ProponentPosition, StatusColor>;
  vote: Record<VoteResult, StatusColor>;
  acceptance: Record<AcceptanceDecision, StatusColor>;
} = {
  assembly: {
    draft: "neutral",
    convened: "info",
    in_session: "success",
    closed: "neutral",
  },
  document: {
    draft: "neutral",
    submitted: "info",
    published: "success",
    withdrawn: "neutral",
    postponed: "warning",
  },
  amendment: {
    draft: "neutral",
    submitted: "info",
    inadmissible: "error",
    withdrawn: "neutral",
    transacted: "secondary",
    lapsed: "warning",
    approved: "success",
    rejected: "error",
  },
  admission: {
    pending: "warning",
    admitted: "success",
    inadmissible: "error",
  },
  position: {
    pending: "neutral",
    accept: "success",
    reject: "error",
    transact: "secondary",
  },
  vote: {
    approved: "success",
    rejected: "error",
  },
  acceptance: {
    pending: "warning",
    accepted: "success",
    rejected: "error",
  },
};

/** The colour of a status value; an unknown one is neutral. */
export function statusColor(kind: StatusKind, value: string): StatusColor {
  const colors = STATUS_COLORS[kind] as Partial<Record<string, StatusColor>>;
  return colors[value] ?? "neutral";
}

/** i18n key of a status label: `common.status.<kind>.<value>`. */
export function statusLabelKey(kind: StatusKind, value: string): string {
  return `common.status.${kind}.${value}`;
}

const AMENDMENT = STATUS_COLORS.amendment;

/**
 * An amendment's state in the room (Directo, the projection): the decided
 * ones as their status badge has them; only the states of the room declare
 * their own colour.
 */
export const LIVE_STATE_COLORS: Record<LiveAmendmentState, StatusColor> = {
  debating: "primary",
  pending: "info",
  late: "warning",
  approved: AMENDMENT.approved,
  incorporated: "success",
  rejected: AMENDMENT.rejected,
  transacted: AMENDMENT.transacted,
  turned_down: "neutral",
  withdrawn: AMENDMENT.withdrawn,
  lapsed: AMENDMENT.lapsed,
  inadmissible: AMENDMENT.inadmissible,
};

/**
 * Where amber means "still waiting for someone" (the control sheet, the
 * console's queue, the projection's list), a lapsed amendment is grey: it is
 * closed, and it never looks like «Pendiente».
 */
export const LAPSED_CLOSED_COLOR: StatusColor = "neutral";

/** An amendment's state in the projection's list: lapsed grey, as closed. */
export const PROJECTION_STATE_COLORS: Record<LiveAmendmentState, StatusColor> =
  { ...LIVE_STATE_COLORS, lapsed: LAPSED_CLOSED_COLOR };

/**
 * The control sheet's exceptions to LIVE_STATE_COLORS: «Pendiente» as in
 * «General», in amber; «Decaído» then in grey, so the two never look alike.
 */
export const CONTROL_SHEET_OVERRIDES = {
  pending: "warning",
  lapsed: LAPSED_CLOSED_COLOR,
} as const satisfies Partial<Record<LiveAmendmentState, StatusColor>>;

/** An amendment's state as the control sheet paints it (page and Excel). */
export const CONTROL_SHEET_STATE_COLORS: Record<
  LiveAmendmentState,
  StatusColor
> = { ...LIVE_STATE_COLORS, ...CONTROL_SHEET_OVERRIDES };

/**
 * The result of a row of «General»: decided as a vote's result; «Pendiente»
 * (no result yet) in amber, as the amendments' pending; the rest grey, so
 * none looks like «Pendiente».
 */
export const CONTROL_SHEET_RESULT_COLORS: Record<
  ControlSheetResult | "pending",
  StatusColor
> = {
  pending: CONTROL_SHEET_OVERRIDES.pending,
  approved: STATUS_COLORS.vote.approved,
  approved_unanimous: STATUS_COLORS.vote.approved,
  rejected: STATUS_COLORS.vote.rejected,
  mixed: "secondary",
  withdrawn: "neutral",
  lapsed: LAPSED_CLOSED_COLOR,
  postponed: "neutral",
  not_applicable: "neutral",
};

/**
 * Where an amendment stands in the console's queue: the statuses as their
 * badge has them, but lapsed grey (closed); what waits on someone (the
 * assembly, the sources, the authors' acceptances, a replacing transactional)
 * in amber, open in blue, and the rest of the open stages grey.
 */
export const SESSION_STAGE_COLORS: Record<SessionAmendmentStage, StatusColor> =
  {
    turned_down: "neutral",
    closed: "neutral",
    superseded: "warning",
    awaiting_authors: "neutral",
    awaiting_validation: "neutral",
    correction_requested: "neutral",
    late: "warning",
    sources_admission: "warning",
    acceptances: "warning",
    open: "info",
    incorporated: "success",
    draft: AMENDMENT.draft,
    inadmissible: AMENDMENT.inadmissible,
    withdrawn: AMENDMENT.withdrawn,
    transacted: AMENDMENT.transacted,
    lapsed: LAPSED_CLOSED_COLOR,
    approved: AMENDMENT.approved,
    rejected: AMENDMENT.rejected,
  };

/**
 * The Excel cell of a colour: the workbook has no brand tones, so primary
 * and secondary read as info.
 */
export const XLSX_STYLE_OF_COLOR: Record<StatusColor, XlsxCellStyle> = {
  primary: "info",
  secondary: "info",
  success: "success",
  info: "info",
  warning: "warning",
  error: "danger",
  neutral: "neutral",
};
