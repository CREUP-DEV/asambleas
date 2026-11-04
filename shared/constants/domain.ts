/**
 * Enumerations of the assembly domain, shared by the database schema, the
 * API validation and the UI. See docs/design.md.
 */

export const ASSEMBLY_STATUSES = [
  "draft",
  "convened",
  "in_session",
  "closed",
] as const;
export type AssemblyStatus = (typeof ASSEMBLY_STATUSES)[number];

/** Allowed status transitions. Going back is possible except from draft. */
export const ASSEMBLY_STATUS_TRANSITIONS: Record<
  AssemblyStatus,
  AssemblyStatus[]
> = {
  draft: ["convened"],
  convened: ["draft", "in_session"],
  in_session: ["convened", "closed"],
  closed: ["in_session"],
};

export const MILESTONE_KEYS = [
  "convocation",
  "agenda_requests_close",
  "agenda_final",
  "documents_close",
  "documents_publish",
  "amendments_open",
  "amendments_close",
  "candidacies_close",
] as const;
export type MilestoneKey = (typeof MILESTONE_KEYS)[number];

export const MEMBER_KINDS = [
  "asociado",
  "sectorial",
  "executive",
  "other",
] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

export const MEMBER_SOURCES = ["intranet", "manual"] as const;
export type MemberSource = (typeof MEMBER_SOURCES)[number];

export const DOCUMENT_KINDS = [
  "positioning",
  "resolution",
  "internal_motion",
  "executive_report",
  "regulation",
  "statutes",
  "budget",
  "accounts",
  "work_plan",
  "agreement",
  "report",
  "minutes",
  "candidacy",
  "venue",
  "other",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_FORMATS = ["structured", "file"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const DOCUMENT_STATUSES = [
  "draft",
  "submitted",
  "published",
  "withdrawn",
  "postponed",
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const MAJORITIES = ["simple", "absolute", "two_thirds"] as const;
export type Majority = (typeof MAJORITIES)[number];

export interface DocumentKindDefaults {
  amendable: boolean;
  voted: boolean;
  majority: Majority;
  /** Prefix of the reference assigned on admission, e.g. "RES 012/2026". */
  referencePrefix?: string;
}

/** Defaults per document kind (RFAG/RRI 2026). All editable per document. */
export const DOCUMENT_KIND_DEFAULTS: Record<
  DocumentKind,
  DocumentKindDefaults
> = {
  positioning: {
    amendable: true,
    voted: true,
    majority: "two_thirds",
    referencePrefix: "PO",
  },
  resolution: {
    amendable: true,
    voted: true,
    majority: "two_thirds",
    referencePrefix: "RES",
  },
  internal_motion: {
    amendable: true,
    voted: true,
    majority: "two_thirds",
    referencePrefix: "MI",
  },
  executive_report: {
    amendable: true,
    voted: true,
    majority: "two_thirds",
    referencePrefix: "IEJ",
  },
  regulation: { amendable: true, voted: true, majority: "two_thirds" },
  statutes: { amendable: true, voted: true, majority: "two_thirds" },
  budget: { amendable: true, voted: true, majority: "simple" },
  accounts: { amendable: false, voted: true, majority: "simple" },
  work_plan: { amendable: false, voted: true, majority: "simple" },
  agreement: { amendable: false, voted: true, majority: "simple" },
  report: { amendable: false, voted: false, majority: "simple" },
  minutes: { amendable: false, voted: true, majority: "simple" },
  candidacy: { amendable: false, voted: true, majority: "simple" },
  venue: { amendable: false, voted: true, majority: "simple" },
  other: { amendable: false, voted: false, majority: "simple" },
};

export const AMENDMENT_KINDS = [
  "partial",
  "formal",
  "totality_return",
  "totality_alternative",
  "transactional",
] as const;
export type AmendmentKind = (typeof AMENDMENT_KINDS)[number];

export const AMENDMENT_STATUSES = [
  "draft",
  "submitted",
  "inadmissible",
  "withdrawn",
  "transacted",
  "lapsed",
  "approved",
  "rejected",
] as const;
export type AmendmentStatus = (typeof AMENDMENT_STATUSES)[number];

/** Statuses after which an amendment is no longer debated. */
export const AMENDMENT_CLOSED_STATUSES: AmendmentStatus[] = [
  "inadmissible",
  "withdrawn",
  "transacted",
  "lapsed",
  "approved",
  "rejected",
];

export const ADMISSION_STATUSES = [
  "pending",
  "admitted",
  "inadmissible",
] as const;
export type AdmissionStatus = (typeof ADMISSION_STATUSES)[number];

/** How an approved amendment got into the text. */
export const APPROVAL_METHODS = [
  "proponent",
  "assent",
  "vote",
  "formal",
] as const;
export type ApprovalMethod = (typeof APPROVAL_METHODS)[number];

export const PROPONENT_POSITIONS = [
  "pending",
  "accept",
  "reject",
  "transact",
] as const;
export type ProponentPosition = (typeof PROPONENT_POSITIONS)[number];

export const ACCEPTANCE_DECISIONS = [
  "pending",
  "accepted",
  "rejected",
] as const;
export type AcceptanceDecision = (typeof ACCEPTANCE_DECISIONS)[number];

export const ACCEPTANCE_ROLES = ["author", "proponent"] as const;
export type AcceptanceRole = (typeof ACCEPTANCE_ROLES)[number];

export const RELATION_KINDS = [
  "incompatible",
  "duplicate",
  "depends_on",
  "consequence_of",
  "subsumed_by",
  "same_in_other_document",
] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

export const VOTE_METHODS = [
  "assent",
  "show_of_hands",
  "secret",
  "roll_call",
  "portal",
] as const;
export type VoteMethod = (typeof VOTE_METHODS)[number];

export const VOTE_RESULTS = ["approved", "rejected"] as const;
export type VoteResult = (typeof VOTE_RESULTS)[number];

export const VOTE_SUBJECTS = [
  "amendment",
  "document",
  "decision",
  "other",
] as const;
export type VoteSubject = (typeof VOTE_SUBJECTS)[number];

export const DECISION_KINDS = [
  "admit_late",
  "inadmission",
  "unify",
  "agenda_change",
  "other",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_METHODS = [
  "mesa",
  "secretaria",
  "assent",
  "vote",
] as const;
export type DecisionMethod = (typeof DECISION_METHODS)[number];

export interface AssemblySettings {
  /** Who sees submitted amendments before the window closes. */
  amendmentVisibility: "immediate" | "after_close";
  /** Who sees the proponent's position on each amendment. */
  positionVisibility: "mesa" | "session" | "public";
  /** Whether amendments accepted by the proponent are incorporated by assent or voted. */
  acceptedAmendments: "assent" | "vote";
  /** Outcome of a tied vote. */
  tieRule: "rejected" | "repeat";
  /** Denominator for majorities. */
  denominator: "valid_votes" | "present";
}

export const DEFAULT_ASSEMBLY_SETTINGS: AssemblySettings = {
  amendmentVisibility: "after_close",
  positionVisibility: "session",
  acceptedAmendments: "assent",
  tieRule: "rejected",
  denominator: "valid_votes",
};
