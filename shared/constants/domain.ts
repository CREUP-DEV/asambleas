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

/**
 * What happens to an amendment the document's presenter accepts:
 * "incorporate" puts it in the text without a vote (regulations), "vote"
 * leaves it to the assembly like any other.
 */
export const ACCEPTED_AMENDMENT_RULES = ["incorporate", "vote"] as const;
export type AcceptedAmendmentRule = (typeof ACCEPTED_AMENDMENT_RULES)[number];

export interface DocumentKindDefaults {
  amendable: boolean;
  voted: boolean;
  majority: Majority;
  acceptedAmendments: AcceptedAmendmentRule;
  /** Prefix of the reference assigned on admission, e.g. "RES 012/2026". */
  referencePrefix?: string;
}

/**
 * Defaults per document kind, all editable per document. Rules in force
 * (2025): agreements need two thirds (RFAG art. 23.1, RRI art. 18.2); in a
 * reform of the Estatutos or a regulation the amendments the presenter
 * accepts join the text (RRI art. 65.5), elsewhere every substantive
 * amendment is voted (RRI art. 18.6). The rest is usual practice.
 */
export const DOCUMENT_KIND_DEFAULTS: Record<
  DocumentKind,
  DocumentKindDefaults
> = {
  positioning: {
    amendable: true,
    voted: true,
    acceptedAmendments: "vote",
    majority: "two_thirds",
    referencePrefix: "PO",
  },
  resolution: {
    amendable: true,
    voted: true,
    acceptedAmendments: "vote",
    majority: "two_thirds",
    referencePrefix: "RES",
  },
  internal_motion: {
    amendable: true,
    voted: true,
    acceptedAmendments: "vote",
    majority: "two_thirds",
    referencePrefix: "MI",
  },
  executive_report: {
    amendable: true,
    voted: true,
    acceptedAmendments: "vote",
    majority: "two_thirds",
    referencePrefix: "IEJ",
  },
  regulation: {
    amendable: true,
    voted: true,
    acceptedAmendments: "incorporate",
    majority: "two_thirds",
  },
  statutes: {
    amendable: true,
    voted: true,
    acceptedAmendments: "vote",
    majority: "two_thirds",
  },
  budget: {
    amendable: true,
    voted: true,
    acceptedAmendments: "vote",
    majority: "simple",
  },
  accounts: {
    amendable: false,
    voted: true,
    acceptedAmendments: "vote",
    majority: "simple",
  },
  work_plan: {
    amendable: false,
    voted: true,
    acceptedAmendments: "vote",
    majority: "simple",
  },
  agreement: {
    amendable: false,
    voted: true,
    acceptedAmendments: "vote",
    majority: "simple",
  },
  report: {
    amendable: false,
    voted: false,
    acceptedAmendments: "vote",
    majority: "simple",
  },
  minutes: {
    amendable: false,
    voted: true,
    acceptedAmendments: "vote",
    majority: "simple",
  },
  candidacy: {
    amendable: false,
    voted: true,
    acceptedAmendments: "vote",
    majority: "simple",
  },
  venue: {
    amendable: false,
    voted: true,
    acceptedAmendments: "vote",
    majority: "simple",
  },
  other: {
    amendable: false,
    voted: false,
    acceptedAmendments: "vote",
    majority: "simple",
  },
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

/** A request to speak, from asking for the floor until it ends. */
export const SPEAKING_TURN_STATUSES = [
  "waiting",
  "speaking",
  "done",
  "cancelled",
] as const;
export type SpeakingTurnStatus = (typeof SPEAKING_TURN_STATUSES)[number];
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

/**
 * Per-assembly policies. Who sees a presented amendment is no longer a
 * policy: the Secretaría validates and publishes each one (see
 * amendments.publishedAt).
 */
export interface AssemblySettings {
  /** Who sees the proponent's position on each amendment. */
  positionVisibility: "mesa" | "session" | "public";
  /** Outcome of a tied vote. */
  tieRule: "rejected" | "repeat";
  /** Denominator for majorities. */
  denominator: "valid_votes" | "present";
}

export const DEFAULT_ASSEMBLY_SETTINGS: AssemblySettings = {
  positionVisibility: "session",
  tieRule: "rejected",
  denominator: "valid_votes",
};
