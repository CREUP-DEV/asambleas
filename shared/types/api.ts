/**
 * API contract shared by Nitro handlers and the Vue client. Dates travel as
 * ISO strings. See docs/api.md for the endpoints that return each shape.
 */
import type { AssemblyType } from "../constants/assemblyTypes";
import type {
  AttendanceMark,
  QuorumCall,
  QuorumRules,
} from "../utils/headcount";
import type {
  AcceptanceDecision,
  AcceptanceRole,
  AcceptedAmendmentRule,
  SpeakingTurnStatus,
  AdmissionStatus,
  AmendmentKind,
  AmendmentStatus,
  ApprovalMethod,
  AssemblySettings,
  AssemblyStatus,
  DecisionKind,
  DecisionMethod,
  DocumentFormat,
  DocumentKind,
  DocumentStatus,
  Majority,
  MemberKind,
  MemberSource,
  MilestoneKey,
  ProponentPosition,
  RelationKind,
  VoteMethod,
  VoteResult,
  VoteSubject,
} from "../constants/domain";
import type { PermissionKey } from "../constants/permissions";
import type {
  AccessRevokedReason,
  ActivityCategory,
  ActivityKind,
  AuditSource,
  ImpersonationEndReason,
  MeActivityTab,
} from "../constants/activity";
import type { AmendmentOp, Block, ChangeKind } from "./content";
import type {
  CalendarDocument,
  CalendarRules,
  CalendarWarning,
} from "../utils/calendar";

/** A document as the calendar check reads it, with ISO dates. */
export type CalendarDocumentDto = Omit<
  CalendarDocument,
  "amendmentsOpenAt" | "amendmentsCloseAt"
> & {
  amendmentsOpenAt: string | null;
  amendmentsCloseAt: string | null;
};

export type IsoDate = string;

// Members ----------------------------------------------------------------

export interface MemberRef {
  id: string;
  acronym: string;
  name: string;
  kind: MemberKind;
}

export interface MemberDto extends MemberRef {
  university: string | null;
  region: string | null;
  source: MemberSource;
  active: boolean;
  syncedAt: IsoDate | null;
  /** Optimistic lock token for PUT /api/members/[id]. */
  updatedAt: IsoDate;
}

export interface MemberSyncResult {
  created: number;
  updated: number;
  deactivated: number;
}

/** The member kinds the Intranet roster lists (asociados and sectorials). */
export type RosterMemberKind = Extract<MemberKind, "asociado" | "sectorial">;

/**
 * Body of POST /api/members/sync (memberSyncBodySchema). The body may be
 * absent, as it was before: that is the same as `{}`.
 */
export interface MemberSyncBody {
  /**
   * Applies a sync that would deactivate every active intranet member of a
   * kind, or more than max(3, 30%) of them, together with `confirmedKinds`.
   * Without it such a sync writes nothing but a `members.sync_blocked` audit
   * row and answers 409 with MemberSyncBlockedData. The scheduled sync never
   * sends it.
   */
  confirmDeactivation?: boolean;
  /**
   * What the account confirmed: the `kinds` of the 409 it was shown. The
   * sync applies only when every kind it would now deactivate too much of is
   * here with at least as many members (isDeactivationConfirmed); if the
   * Intranet returns less on the retry, it answers 409 again with the new
   * counts. Without it `confirmDeactivation` confirms nothing.
   */
  confirmedKinds?: MemberSyncConfirmedKind[];
}

/** One kind the account agreed to deactivate members of, and how many. */
export type MemberSyncConfirmedKind = Pick<
  MemberSyncDeactivationKind,
  "kind" | "toDeactivate"
>;

/** One member kind a refused roster sync would deactivate too much of. */
export interface MemberSyncDeactivationKind {
  kind: RosterMemberKind;
  /** Active intranet members of the kind before the sync. */
  active: number;
  /** How many of them the sync would deactivate. */
  toDeactivate: number;
}

/**
 * `data` of the 409 that POST /api/members/sync answers when the sync needs
 * `confirmDeactivation: true` (only the kinds over the limit are listed).
 * The client shows the counts and repeats the request with it.
 */
export interface MemberSyncBlockedData {
  reason: "large_deactivation";
  kinds: MemberSyncDeactivationKind[];
}

export interface MeDto {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string | null;
  permissions: PermissionKey[];
  isAdmin: boolean;
  member: MemberRef | null;
  /**
   * Set while an Admin acts as this account: every field above is then the
   * account acted as (permissions, member, isAdmin false), and this names
   * the real Admin for the banner. null otherwise. Identity comes only from
   * here: better-auth's own get-session keeps reporting the Admin.
   */
  impersonation: MeImpersonationDto | null;
}

/** MeDto.impersonation: the impersonation the current request runs under. */
export interface MeImpersonationDto {
  /** impersonations.id. */
  id: string;
  /** The real Admin acting as the account. */
  by: UserRef;
  startedAt: IsoDate;
  /** When it ends by itself (fixed, never renewed): the banner counts down and reloads. */
  expiresAt: IsoDate;
}

/**
 * GET /api/me/work: what the signed-in user has to do or is waiting for,
 * across assemblies that are not closed. Drives the home page.
 */
export interface MeWorkDto {
  /** Documents the user's member presents: drafts, expected, presented, published. */
  documents: MeWorkDocumentDto[];
  /** Amendments the user's member authored that are not decided yet. */
  amendments: MeWorkAmendmentDto[];
  /** For the Secretaría (document:manage / amendment:review): items waiting for it. */
  review: MeWorkReviewDto[];
  /** Published documents the user's member presents with amendments to answer. */
  proponent: MeWorkProponentDto[];
  /** Transactionals waiting for the user's member's answer. */
  acceptances: MeWorkAcceptanceDto[];
  /** Recent decisions others took on the member's documents and amendments. */
  news: MeWorkNewsDto[];
}

export interface MeWorkProponentDto {
  assembly: MeWorkAssemblyRef;
  document: { id: string; slug: string; title: string };
  /** Undecided amendments with no position from the main presenter yet. */
  positionsPending: number;
}

/** A transactional waiting for the user's member to accept or reject it. */
export interface MeWorkAcceptanceDto {
  assembly: MeWorkAssemblyRef;
  document: { id: string; slug: string; title: string };
  transactional: { id: string; code: string | null };
  /**
   * Who proposes it: its main author, or null when the Mesa presented it on
   * nobody's behalf.
   */
  proposedBy: MemberRef | null;
  /** The user's amendments it would replace. */
  replaces: { id: string; code: string | null }[];
}

/**
 * Something decided about the user's member's work by someone else: the
 * main presenter answering an amendment to a document the member co-presents,
 * a main author answering a transactional over an amendment the member
 * co-authored, and the Secretaría or the assembly settling them.
 */
export interface MeWorkNewsDto {
  id: string;
  assembly: MeWorkAssemblyRef;
  document: { id: string; slug: string; title: string };
  amendment: { id: string; code: string | null } | null;
  /** The amendment is one the user's member authored ("tu enmienda"). */
  ownAmendment: boolean;
  /** The event type (position_changed, acceptance_recorded, amendment_validated...). */
  type: string;
  /** Who decided: the member acting, when there is one. */
  by: MemberRef | null;
  /**
   * The Admin who did it while acting as this very account (so the account
   * did not decide it). Filled only on that account's own acts.
   */
  impersonatedBy?: UserRef | null;
  /** The decision in short: the position, the acceptance decision, the status. */
  value: string | null;
  at: IsoDate;
}

export interface MeWorkAssemblyRef {
  id: string;
  slug: string;
  label: string;
}

export interface MeWorkDocumentDto {
  assembly: MeWorkAssemblyRef;
  document: DocumentSummaryDto;
}

export interface MeWorkAmendmentDto {
  assembly: MeWorkAssemblyRef;
  document: { id: string; slug: string; title: string };
  amendment: {
    id: string;
    code: string | null;
    status: AmendmentStatus;
    reviewState: AmendmentReviewState | null;
    correctionNote: string | null;
    late: boolean;
    admission: AdmissionStatus;
    updatedAt: IsoDate;
  };
}

export interface MeWorkReviewDto {
  assembly: MeWorkAssemblyRef;
  /** Documents presented and waiting for validation (publication). */
  documentsToValidate: number;
  /** Amendments presented and waiting for validation. */
  amendmentsToValidate: number;
  /** Amendments validated but not published yet. */
  amendmentsToPublish: number;
  /** Expected documents past their internal deadline and not presented. */
  documentsOverdue: number;
}

/**
 * GET /api/assemblies/[assembly]/review (document:manage or
 * amendment:review): the Secretaría's validation inbox.
 */
export interface ReviewQueueDto {
  /** Presented documents waiting for validation (publication). */
  documents: DocumentSummaryDto[];
  /** Amendments waiting for validation or publication, by document. */
  amendments: ReviewQueueAmendmentDto[];
}

export interface ReviewQueueAmendmentDto {
  document: {
    id: string;
    slug: string;
    title: string;
    reference: string | null;
  };
  amendment: AmendmentDto;
}

// Assemblies -------------------------------------------------------------

export interface MilestoneDto {
  key: MilestoneKey;
  at: IsoDate;
  note: string | null;
}

export interface AssemblyCapabilities {
  manage: boolean;
  moderate: boolean;
  createDocuments: boolean;
}

export interface AssemblySummaryDto {
  id: string;
  slug: string;
  /** "80.ª AGO" */
  label: string;
  number: number;
  type: AssemblyType;
  status: AssemblyStatus;
  startDate: IsoDate;
  endDate: IsoDate;
  location: string;
  agendaFinalizedAt: IsoDate | null;
  documentCount: number;
  /** Next milestone still to come, for countdowns. */
  nextMilestone: MilestoneDto | null;
  updatedAt: IsoDate;
}

export interface AssemblyDto extends AssemblySummaryDto {
  convocationIntro: string | null;
  settings: AssemblySettings;
  milestones: MilestoneDto[];
  /**
   * From checkCalendar with the type's rules and, for managers, the
   * amendable regulation and statutes documents (reform window).
   */
  calendarWarnings: CalendarWarning[];
  /** The calendar rules of the assembly's type, for the calendar editor. */
  calendarRules: CalendarRules;
  /**
   * Managers only (empty otherwise): the documents the reform window check
   * needs, so the calendar editor can repeat it while dates change.
   */
  calendarDocuments: CalendarDocumentDto[];
  can: AssemblyCapabilities;
}

export interface AssemblyListDto {
  items: AssemblySummaryDto[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AssemblyCreateBody {
  number: number;
  type: AssemblyType;
  startDate: IsoDate;
  endDate: IsoDate;
  location: string;
  /** Fill the calendar from the type defaults. Default true. */
  applyDefaultCalendar?: boolean;
}

export interface AssemblyUpdateBody {
  number?: number;
  type?: AssemblyType;
  startDate?: IsoDate;
  endDate?: IsoDate;
  location?: string;
  convocationIntro?: string | null;
  settings?: Partial<AssemblySettings>;
  updatedAt: IsoDate;
}

export interface AssemblyStatusBody {
  status: AssemblyStatus;
  updatedAt: IsoDate;
}

/** The calendar rules of one assembly type (GET /api/calendar-rules). */
export interface CalendarRulesDto {
  type: AssemblyType;
  rules: CalendarRules;
  /** For optimistic locking; null while the type has no stored row. */
  updatedAt: IsoDate | null;
  /** False while the type has no stored row and the initial rules apply. */
  stored: boolean;
}

/** PUT /api/calendar-rules/[type]. */
export interface CalendarRulesBody {
  rules: CalendarRules;
  /** The `updatedAt` the client read; null while the type had no stored row. */
  updatedAt: IsoDate | null;
}

export interface CalendarBody {
  milestones: { key: MilestoneKey; at: IsoDate | null; note?: string | null }[];
  /** Mark the agenda as final (ODD definitivo) or reopen it. */
  agendaFinal?: boolean;
}

// Agenda -----------------------------------------------------------------

export interface AgendaItemDto {
  id: string;
  parentId: string | null;
  title: string;
  description: string | null;
  order: number;
  /** Members present documents under this item (a "container" item). */
  acceptsSubmissions: boolean;
  /**
   * The document kinds members may present here while `acceptsSubmissions`
   * is on. Empty means every kind (see itemAcceptsKind).
   */
  submissionKinds: DocumentKind[];
  /**
   * An automatic sub-item: the server created it for a document presented
   * under an item that accepts submissions. It goes when that document is
   * deleted or moved away, unless it holds something else by then.
   */
  auto: boolean;
  /** The document an automatic sub-item was created for; null otherwise. */
  generatedForDocumentId: string | null;
  /**
   * A manager renamed the automatic sub-item, so its title no longer
   * follows the document's.
   */
  titleCustom: boolean;
  updatedAt: IsoDate;
}

export interface AgendaDto {
  items: AgendaItemDto[];
  documents: DocumentSummaryDto[];
}

export interface AgendaItemBody {
  parentId?: string | null;
  title: string;
  description?: string | null;
  acceptsSubmissions?: boolean;
  /**
   * The kinds members may present here; empty or left out on a create means
   * every kind. Stored empty while `acceptsSubmissions` is off.
   */
  submissionKinds?: DocumentKind[];
  updatedAt?: IsoDate;
  /**
   * Go ahead although the agenda is final. Needed to create, move or rename
   * a root item then; without it the server answers 409 `agenda_final`.
   */
  confirmFinal?: boolean;
}

export interface AgendaReorderBody {
  items: { id: string; parentId: string | null; order: number }[];
  /** As in AgendaItemBody, when the sequence of root items changes. */
  confirmFinal?: boolean;
}

// Documents --------------------------------------------------------------

export interface AmendmentWindowDto {
  opensAt: IsoDate | null;
  closesAt: IsoDate | null;
  open: boolean;
}

export interface DocumentSummaryDto {
  id: string;
  slug: string;
  agendaItemId: string;
  kind: DocumentKind;
  format: DocumentFormat;
  title: string;
  reference: string | null;
  status: DocumentStatus;
  /** The main presenter: it answers the amendments to the document. */
  proponent: MemberRef | null;
  /** Members presenting it jointly with the main presenter. */
  coProponents: MemberRef[];
  amendable: boolean;
  /** What an amendment the main presenter accepts becomes. */
  acceptedAmendments: AcceptedAmendmentRule;
  voted: boolean;
  majority: Majority;
  /** Amendments past draft that the viewer can see. */
  amendmentCount: number;
  /**
   * Whether the document has any amendment at all, of any status, drafts
   * and other members' unpublished ones included: what keeps its agenda
   * item from being deleted. Only for those who delete documents or agenda
   * items (document:manage or assembly:manage); null for everyone else.
   */
  hasAmendments: boolean | null;
  window: AmendmentWindowDto;
  publishedAt: IsoDate | null;
  /** Presented to the Secretaría (null while it is a draft). */
  submittedAt: IsoDate | null;
  /** Internal deadline set by the Secretaría for expected documents. */
  dueAt: IsoDate | null;
  /** Text or PDF is present (a placeholder created by the Secretaría has none). */
  hasContent: boolean;
  /**
   * The Secretaría asked for a correction and the document went back to
   * draft. Only returned to its presenters and managers; null otherwise.
   */
  correctionNote: string | null;
  correctionRequestedAt: IsoDate | null;
  /** Final text approved and stored. */
  consolidated: boolean;
  updatedAt: IsoDate;
}

export interface VersionDto {
  id: string;
  number: number;
  kind: "draft" | "base" | "consolidated";
  blocks: Block[];
  contentHash: string;
  createdAt: IsoDate;
}

export interface DocumentCapabilities {
  /** Edit metadata and the working draft (before publication). */
  edit: boolean;
  /**
   * Secretaría-level management at any stage: metadata (window override,
   * majority, voted) and status changes (withdraw, postpone).
   * document:manage.
   */
  manage: boolean;
  publish: boolean;
  /**
   * Delete the document for good (document:manage): any document without a
   * final vote, and once published only while it has no amendments
   * (deleteBlocker). A published one that has them is withdrawn instead.
   */
  delete: boolean;
  /** Present amendments now (window open or late submission allowed). */
  amend: boolean;
  /** Record proponent positions. */
  position: boolean;
  moderate: boolean;
}

export interface DocumentDto extends DocumentSummaryDto {
  summary: string | null;
  fileUrl: string | null;
  fileName: string | null;
  /**
   * Stored per-document amendment window override; null means the assembly
   * calendar applies. `window` is the effective one.
   */
  amendmentsOpenAt: IsoDate | null;
  amendmentsCloseAt: IsoDate | null;
  /**
   * Working draft, returned to everyone who can see the unpublished document
   * (proponent, managers, the Mesa) and hidden once the text is frozen.
   * Editing is governed by `can.edit`.
   */
  workingVersion: VersionDto | null;
  baseVersion: VersionDto | null;
  consolidatedVersion: VersionDto | null;
  finalVote: VoteDto | null;
  positionsVisible: boolean;
  can: DocumentCapabilities;
}

export interface DocumentCreateBody {
  agendaItemId: string;
  kind: DocumentKind;
  format: DocumentFormat;
  title: string;
  summary?: string | null;
  /** Main presenter. Required when there are co-presenters. */
  proponentMemberId?: string | null;
  /** Members presenting it jointly (never the main presenter). */
  coProponentMemberIds?: string[];
  /** Defaults come from the kind. */
  amendable?: boolean;
  acceptedAmendments?: AcceptedAmendmentRule;
  voted?: boolean;
  majority?: Majority;
  blocks?: Block[];
  /** Managers only: internal deadline for an expected document. */
  dueAt?: IsoDate | null;
}

/**
 * Body of POST .../agenda/[item]/documents: several documents for one
 * agenda item, created together (managers only).
 */
export interface BulkDocumentsBody {
  documents: {
    title: string;
    kind: DocumentKind;
    format: DocumentFormat;
    /** Main presenter; left out or null leaves the document without one. */
    proponentMemberId?: string | null;
    /** Internal deadline for an expected document. */
    dueAt?: IsoDate | null;
  }[];
}

/** One document the bulk create made, in the order of the request. */
export interface BulkCreatedDocumentDto {
  id: string;
  slug: string;
  title: string;
  kind: DocumentKind;
  format: DocumentFormat;
  /** The item it hangs from: its automatic sub-item, when it got one. */
  agendaItemId: string;
}

export interface BulkDocumentsDto {
  documents: BulkCreatedDocumentDto[];
}

export interface DocumentUpdateBody {
  title?: string;
  summary?: string | null;
  kind?: DocumentKind;
  /**
   * Structured text or uploaded PDF, while the text is not frozen. Switching
   * keeps the other one (the draft text or the PDF) for a switch back.
   */
  format?: DocumentFormat;
  agendaItemId?: string;
  proponentMemberId?: string | null;
  coProponentMemberIds?: string[];
  amendable?: boolean;
  voted?: boolean;
  majority?: Majority;
  acceptedAmendments?: AcceptedAmendmentRule;
  amendmentsOpenAt?: IsoDate | null;
  amendmentsCloseAt?: IsoDate | null;
  /** Managers only. */
  dueAt?: IsoDate | null;
  status?: "withdrawn" | "postponed" | "submitted";
  updatedAt: IsoDate;
}

/**
 * POST .../documents/[document]/correction (document:manage): a submitted
 * document goes back to draft with a note for its presenters, who fix it
 * and present it again. Returns DocumentDto.
 */
export interface CorrectionBody {
  note: string;
  updatedAt: IsoDate;
}

export interface DocumentContentBody {
  blocks: Block[];
  /** contentHash of the working version the client edited. */
  baseHash: string;
}

export interface DocxImportDto {
  blocks: Block[];
  warnings: (
    | "tracked_changes"
    | "comments"
    | "images_dropped"
    | "images_in_tables"
    | "images_without_alt"
    | "tables_flattened"
    | "highlight"
  )[];
}

// Amendments -------------------------------------------------------------

export interface AcceptanceDto {
  member: MemberRef;
  role: AcceptanceRole;
  decision: AcceptanceDecision;
  decidedAt: IsoDate | null;
  /**
   * The party answered, or the Mesa recorded its answer in the room, as it
   * was then (the latest acceptance_recorded event).
   */
  recordedBy: "party" | "mesa";
}

export interface PositionDto {
  position: ProponentPosition;
  comment: string | null;
  /** The main presenter answered, or the Mesa recorded it on its behalf. */
  recordedBy: "presenter" | "mesa";
  updatedAt: IsoDate;
}

export interface AmendmentCapabilities {
  edit: boolean;
  submit: boolean;
  withdraw: boolean;
  /** The actor is a pending party of this transactional. */
  accept: boolean;
  position: boolean;
  moderate: boolean;
  review: boolean;
  /** Validate it or ask for a correction (submitted, not validated yet). */
  validate: boolean;
  /** Make it visible to everyone (validated, not published yet). */
  publish: boolean;
}

/**
 * Where an amendment stands for its authors and the Secretaría:
 * - "pending_authors": a transactional waiting for the main author of each
 *   amendment it would replace to accept it, before the Secretaría checks it;
 * - "pending_validation": presented, the Secretaría has not checked it;
 * - "correction_requested": back to draft with a note to fix;
 * - "validated": checked but not visible to everyone yet, and still relevant
 *   to the debate (not withdrawn nor inadmissible);
 * - "published": visible to everyone who can see the document.
 * Null for drafts that were never presented, and for amendments settled
 * while private (withdrawn, lapsed or inadmissible before being published).
 */
export type AmendmentReviewState =
  | "pending_authors"
  | "pending_validation"
  | "correction_requested"
  | "validated"
  | "published";

export interface AmendmentDto {
  id: string;
  documentId: string;
  number: number | null;
  code: string | null;
  kind: AmendmentKind;
  status: AmendmentStatus;
  admission: AdmissionStatus;
  late: boolean;
  ops: AmendmentOp[];
  globalReplace: { find: string; replace: string } | null;
  justification: string;
  positionKey: number;
  changeKinds: ChangeKind[];
  /** Presenting members, the main author first. */
  authors: MemberRef[];
  /**
   * The main author: it answers the transactionals proposed over this
   * amendment. Required when there are co-authors.
   */
  mainAuthorId: string | null;
  submittedAt: IsoDate | null;
  validatedAt: IsoDate | null;
  publishedAt: IsoDate | null;
  reviewState: AmendmentReviewState | null;
  /** Only returned to its authors and the Secretaría/Mesa; null otherwise. */
  correctionNote: string | null;
  decidedAt: IsoDate | null;
  approvalMethod: ApprovalMethod | null;
  outcomeNote: string | null;
  outcomeVote: VoteDto | null;
  /** Null when positions are hidden from the actor. */
  position: PositionDto | null;
  /** Parents of a transactional. */
  sourceIds: string[];
  /** Transactionals built on this amendment. */
  transactionalIds: string[];
  acceptances: AcceptanceDto[];
  updatedAt: IsoDate;
  can: AmendmentCapabilities;
}

export interface RelationDto {
  id: string;
  fromId: string;
  toId: string;
  kind: RelationKind;
  note: string | null;
  createdAt: IsoDate;
}

export interface DocumentAmendmentsDto {
  amendments: AmendmentDto[];
  relations: RelationDto[];
  baseVersionId: string | null;
}

export interface AmendmentDraftBody {
  kind: Exclude<AmendmentKind, "transactional">;
  ops: AmendmentOp[];
  justification: string;
  /** Co-presenting members. The actor's member is always included. */
  authorMemberIds?: string[];
  /** Main author among the authors; required when there are several. */
  mainAuthorMemberId?: string | null;
  globalReplace?: { find: string; replace: string } | null;
  /** Moderators may present on behalf of a member (e.g. dictated in session). */
  onBehalfOfMemberId?: string | null;
}

export interface AmendmentUpdateBody extends Partial<AmendmentDraftBody> {
  updatedAt: IsoDate;
}

export interface TransactionalBody {
  sourceIds: string[];
  ops: AmendmentOp[];
  justification: string;
  /** Proposed by these members; defaults to the actor's member. */
  authorMemberIds?: string[];
  /** Main author among the proposers; required when there are several. */
  mainAuthorMemberId?: string | null;
  /** Submit right away (typical in session). Default true. */
  submit?: boolean;
}

export interface AdmissionBody {
  amendmentIds: string[];
  decision: "admitted" | "inadmissible";
  method: DecisionMethod;
  note?: string | null;
  vote?: VoteInput | null;
}

export interface PositionBody {
  position: ProponentPosition;
  comment?: string | null;
  /**
   * PositionDto.updatedAt the client saw (null when there was none), so two
   * people answering at once get a 409 instead of overwriting each other.
   */
  positionUpdatedAt?: IsoDate | null;
}

export interface AcceptanceBody {
  decision: "accepted" | "rejected";
  /** Moderators record a party's answer given in the room. */
  memberId?: string | null;
}

export interface VoteInput {
  method: VoteMethod;
  inFavor?: number;
  against?: number;
  abstentions?: number;
  blank?: number;
  invalid?: number;
  present?: number | null;
  majority?: Majority;
  note?: string | null;
}

export type OutcomeAction =
  | {
      action: "approve";
      method: Exclude<ApprovalMethod, "vote">;
      note?: string | null;
    }
  | { action: "vote"; vote: VoteInput }
  | { action: "withdraw"; note?: string | null }
  | { action: "lapse"; note?: string | null }
  | { action: "reopen"; note?: string | null };

export type OutcomeBody = OutcomeAction & { updatedAt: IsoDate };

/**
 * POST .../documents/[document]/amendments/validate (amendment:review):
 * validates submitted amendments in bulk. On-time ones are admitted at the
 * same time (method "secretaria"); late ones keep admission "pending" for the
 * Mesa. With `publish` they become visible to everyone at once.
 * Returns DocumentAmendmentsDto.
 */
export interface ValidateAmendmentsBody {
  amendmentIds: string[];
  publish: boolean;
}

/**
 * POST .../documents/[document]/amendments/publish (amendment:review):
 * makes validated amendments visible to everyone. Returns
 * DocumentAmendmentsDto.
 */
export interface PublishAmendmentsBody {
  amendmentIds: string[];
}

/**
 * POST .../amendments/[amendment]/correction (amendment:review): a submitted,
 * not yet validated amendment goes back to draft with a note for its authors
 * (CorrectionBody). Returns AmendmentDto.
 */

export interface RelationBody {
  fromId: string;
  toId: string;
  kind: RelationKind;
  note?: string | null;
}

export interface FinalVoteBody {
  vote: VoteInput;
  /** Amendment ids in application order; defaults to approval order. */
  order?: string[];
}

/**
 * DELETE .../documents/[document]/final-vote: annuls a wrongly recorded final
 * vote (session:moderate, assembly not closed). The vote row stays for the
 * record; the document loses finalVoteId and its consolidated version, and a
 * `final_vote_annulled` event is recorded. Returns DocumentDto.
 */
export interface FinalVoteAnnulBody {
  updatedAt: IsoDate;
  note?: string | null;
}

/** Ids the client can offer to lapse after an approval. */
export interface ApprovalWarnings {
  /** Approved amendments that collide with this one in the base text. */
  overlapsWithApproved: string[];
  /** Undecided or approved amendments linked by an "incompatible" relation. */
  incompatible: string[];
}

/** Response of POST .../amendments/[amendment]/outcome. */
export interface AmendmentOutcomeDto {
  amendment: AmendmentDto;
  vote: VoteDto | null;
  /** Present when the amendment ended up approved, null otherwise. */
  warnings: ApprovalWarnings | null;
}

/** Response of POST .../amendments/admission. */
export interface AmendmentAdmissionDto {
  decision: DecisionDto;
  /** The admission applied to every amendment (a failed vote reverses it). */
  admission: Exclude<AdmissionStatus, "pending">;
  amendmentIds: string[];
}

// Votes, decisions, live -------------------------------------------------

export interface VoteDto {
  id: string;
  subjectType: VoteSubject;
  subjectId: string;
  method: VoteMethod;
  inFavor: number;
  against: number;
  abstentions: number;
  blank: number;
  invalid: number;
  present: number | null;
  majority: Majority;
  result: VoteResult;
  note: string | null;
  recordedAt: IsoDate;
}

export interface DecisionDto {
  id: string;
  kind: DecisionKind;
  method: DecisionMethod;
  subjectIds: string[];
  note: string | null;
  vote: VoteDto | null;
  decidedAt: IsoDate;
}

export interface LiveStateDto {
  agendaItemId: string | null;
  documentId: string | null;
  amendmentId: string | null;
  vote: VoteDto | null;
  message: string | null;
  /** Attendees see who has the floor and who is next. */
  speakersVisible: boolean;
  updatedAt: IsoDate | null;
}

export interface LiveStateBody {
  agendaItemId?: string | null;
  documentId?: string | null;
  amendmentId?: string | null;
  voteId?: string | null;
  message?: string | null;
  speakersVisible?: boolean;
}

// Headcounts ---------------------------------------------------------------

/** One asociado counted in a headcount. */
export interface HeadcountEntryDto {
  member: MemberRef;
  mark: AttendanceMark;
  /** The member in the room that votes for this one (when delegated). */
  delegate: MemberRef | null;
}

/** A headcount the Mesa took: a snapshot of that moment. */
export interface HeadcountDto {
  id: string;
  call: QuorumCall;
  /** Active asociados when it was taken. */
  eligible: number;
  inRoom: number;
  delegated: number;
  /** In the room plus delegated. */
  present: number;
  /** Members needed for quorum under the rules then in force. */
  required: number;
  quorum: boolean;
  note: string | null;
  takenAt: IsoDate;
  updatedAt: IsoDate;
  entries: HeadcountEntryDto[];
}

/**
 * GET /api/assemblies/[assembly]/headcounts (session:moderate, or
 * amendment:review). Headcounts newest first; `latest` is the one in force
 * (headcounts[0]). `members` are the asociados with a vote now and
 * `quorum` the rules of the assembly type, for a new count.
 */
export interface HeadcountsDto {
  headcounts: HeadcountDto[];
  latest: HeadcountDto | null;
  members: MemberRef[];
  quorum: QuorumRules;
}

/** One mark of the Mesa's form; absent members are left out. */
export interface HeadcountEntryInput {
  memberId: string;
  mark: AttendanceMark;
  delegateId?: string | null;
}

/** POST /api/assemblies/[assembly]/headcounts (session:moderate). */
export interface HeadcountBody {
  call: QuorumCall;
  entries: HeadcountEntryInput[];
  note?: string | null;
}

/**
 * PUT /api/assemblies/[assembly]/headcounts/[headcount] (session:moderate):
 * corrects a count. Eligibility and the threshold stay those of the moment
 * it was taken. Returns HeadcountsDto.
 */
export interface HeadcountUpdateBody extends HeadcountBody {
  updatedAt: IsoDate;
}

// Speaking turns -----------------------------------------------------------

/** A request to speak written down by the Mesa. */
export interface SpeakingTurnDto {
  id: string;
  /** Who speaks for: a council, sectorial or CEA area. */
  member: MemberRef | null;
  /** The person's name, when the Mesa wrote it. */
  speaker: string | null;
  agendaItemId: string | null;
  status: SpeakingTurnStatus;
  position: number;
  startedAt: IsoDate | null;
  endedAt: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

/**
 * GET /api/assemblies/[assembly]/speakers. The Mesa (session:moderate) gets
 * every turn of the current agenda item and the waiting ones; anyone else
 * gets the speaking and waiting turns only while `visible` is true, and an
 * empty list otherwise.
 */
export interface SpeakersDto {
  visible: boolean;
  turns: SpeakingTurnDto[];
}

/** POST /api/assemblies/[assembly]/speakers (session:moderate): add to the queue. */
export interface SpeakingTurnBody {
  memberId?: string | null;
  speaker?: string | null;
  /** Defaults to the agenda item in debate (live state). */
  agendaItemId?: string | null;
}

/**
 * PUT /api/assemblies/[assembly]/speakers/[turn] (session:moderate).
 * Setting status "speaking" ends the turn that was speaking ("done").
 * `position` reorders the waiting queue. Returns SpeakersDto.
 */
export interface SpeakingTurnUpdateBody {
  status?: SpeakingTurnStatus;
  position?: number;
  speaker?: string | null;
  updatedAt: IsoDate;
}

export interface EventDto {
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  actorName: string | null;
  actorMember: MemberRef | null;
  /**
   * The real Admin when it was done while acting as the actor's account.
   * Filled only for that account and for Admins; absent or null otherwise.
   */
  impersonatedBy?: UserRef | null;
  createdAt: IsoDate;
}

/** Server-sent event pushed on GET /api/assemblies/[assembly]/live. */
export interface LiveEventDto {
  entityType: string;
  entityId: string;
  type: string;
  documentId?: string;
}

// Admin users ---------------------------------------------------------------

/**
 * A row of GET /api/admin/users (`data`), also returned by the endpoints
 * that change one user so the client can replace it in place
 * (server/utils/auth/adminUsers.ts, ADMIN_USER_COLUMNS).
 */
export interface AdminUserDto {
  /** better-auth id. */
  id: string;
  name: string;
  email: string;
  image: string | null;
  roleId: string | null;
  /** The member the account acts for (users.memberId). */
  memberId: string | null;
  /** Intranet data from the last successful role lookup. */
  externalRole: string | null;
  externalName: string | null;
  externalInitials: string | null;
  university: string | null;
  /** The last successful role lookup; a failed one never moves it. */
  lastRoleSyncAt: IsoDate | null;
  /**
   * When the account lost access to the platform (the Intranet deleted it);
   * null while it has access. It comes back by itself when the Intranet
   * knows the account again on a sign-in.
   */
  accessRevokedAt: IsoDate | null;
  /** Why it lost access; null exactly when `accessRevokedAt` is. */
  accessRevokedReason: AccessRevokedReason | null;
  createdAt: IsoDate;
  role: { id: string; name: string } | null;
  member: MemberRef | null;
  /** Permissions granted on top of the role (user_permissions), in catalog order. */
  extraPermissions: PermissionKey[];
}

// Impersonation ------------------------------------------------------------

/**
 * A user as the activity and impersonation lists name them: the intranet
 * name when known, otherwise the Google name (coalesce(external_name, name)).
 * Never carries the email.
 */
export interface UserRef {
  id: string;
  name: string;
}

/**
 * POST /api/admin/users/[id]/impersonate: the Admin starts acting as the
 * account `[id]` (better-auth id). Admin only (real role), never as itself
 * (422) nor as another Admin (403), never nested (409).
 */
export interface ImpersonationStartBody {
  /** Why the Admin needs it: 1..IMPERSONATION_REASON_MAX_LENGTH characters, one line. */
  reason: string;
}

/**
 * One impersonation (an impersonations row). Returned by POST
 * /api/admin/users/[id]/impersonate, and shown to the account acted as in
 * "Mi actividad" (MeActivityPageDto.recentImpersonations, items of kind
 * `impersonation`).
 */
export interface ImpersonationDto {
  id: string;
  /** The real Admin; null if that account no longer exists. */
  admin: UserRef | null;
  /** The account acted as; null if it no longer exists. */
  target: UserRef | null;
  /** The reason the Admin gave. */
  reason: string;
  startedAt: IsoDate;
  /** Fixed on start: start + IMPERSONATION_TTL_MINUTES, or the Admin's session end if sooner. */
  expiresAt: IsoDate;
  /** When it ended; null while open. An expiry closed lazily ends at expiresAt. */
  endedAt: IsoDate | null;
  endReason: ImpersonationEndReason | null;
  /** Open and not expired at the time of the response. */
  active: boolean;
}

/** GET /api/admin/impersonations item (Admin only): adds where it came from and what was done. */
export interface AdminImpersonationDto extends ImpersonationDto {
  /** The account acted as, with its member and current role name. */
  target: (UserRef & { member: MemberRef | null; role: string | null }) | null;
  /** The Admin's client when it started. */
  ipAddress: string | null;
  userAgent: string | null;
  /**
   * Events plus audit rows recorded under it (impersonation_id), without
   * its own impersonation.* rows. Drill down with GET
   * /api/admin/activity?impersonation=<id>.
   */
  actionCount: number;
}

/**
 * GET /api/admin/impersonations query, as parsed by
 * adminImpersonationQuerySchema. Newest first, keyset on (started_at, id).
 */
export interface AdminImpersonationQuery {
  /** Started by this Admin (better-auth user id). */
  admin?: string;
  /** On this account (better-auth user id). */
  target?: string;
  /** true: only open and not expired; false: only ended or expired. */
  active?: boolean;
  /** Opaque on the wire (the previous page's nextCursor); parsed into its position. */
  cursor?: ActivityCursor;
  /** 1..ADMIN_ACTIVITY_MAX_LIMIT, default ACTIVITY_PAGE_DEFAULT_LIMIT. */
  limit: number;
}

export interface AdminImpersonationPageDto {
  items: AdminImpersonationDto[];
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

// Activity -----------------------------------------------------------------

/**
 * Keyset position of an activity list: the last item's time and id. `at`
 * is the database timestamp with microseconds (clock_timestamp()), as text:
 * a JS Date would drop them and skip rows. Travels encoded as an opaque
 * string (encodeActivityCursor / decodeActivityCursor in
 * shared/utils/schemas/activity.ts).
 */
export interface ActivityCursor {
  /** ISO 8601 in UTC with up to microseconds, e.g. "2026-11-05T10:15:30.123456Z". */
  at: string;
  /** The row id (cuid2), unique across events, audit_log and impersonations. */
  id: string;
}

/** Who did something, in an activity item. */
export interface ActivityActorDto extends UserRef {
  /** The member the account acted for at the time (events only; null for audit rows). */
  member: MemberRef | null;
}

/** What an activity item is about. */
export interface ActivityTargetDto {
  /**
   * events.entity_type (assembly, agenda_item, document, amendment, vote,
   * decision, live, speakers) or audit_log.target_type (AuditTargetType);
   * `user` for items of kind impersonation.
   */
  type: string;
  /** events.entity_id or audit_log.target_id. */
  id: string;
  /**
   * Human label: the document title, the amendment code, the agenda item
   * title, the user's name, the role name, the member acronym. null when
   * unknown or not available.
   */
  label: string | null;
  /** The assembly it belongs to, for links and filters (label "80.ª AGO"). */
  assembly: { id: string; slug: string; label: string } | null;
  /** The document it belongs to (documents and amendments), for links. */
  document: { id: string; slug: string; title: string } | null;
  /**
   * false when the viewer can no longer see it, or it was deleted: the item
   * keeps its type, time and assembly, with label, document and payload
   * emptied ("Acción sobre un elemento que ya no puedes ver").
   */
  available: boolean;
}

/** Where an access came from. Only the account's own rows and Admins see it. */
export interface ActivityAccessDto {
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * One row of an activity list: an event (the assembly history), an
 * audit_log row, or an impersonation window. Lists are newest first and
 * paged by (at, id).
 */
export interface ActivityItemDto {
  /** The row id (events.id, audit_log.id or impersonations.id). Key lists by `${kind}:${id}`. */
  id: string;
  kind: ActivityKind;
  at: IsoDate;
  /**
   * events.type (EVENT_TYPES), audit_log.action (AUDIT_ACTIONS), or
   * IMPERSONATION_SESSION_ACTION for kind impersonation. UI label:
   * `activity.actions.<action>`, falling back to `activity.actions.other`.
   */
  action: string;
  /** activityCategory(kind, action). */
  category: ActivityCategory;
  /** audit_log.source; "user" for events and impersonations. */
  source: AuditSource;
  /** Who did it (the account acted as, when impersonated); null for the system or the intranet. */
  actor: ActivityActorDto | null;
  /**
   * The real Admin when it was done while acting as `actor`. Only filled
   * for the account acted as and for Admins; everyone else sees null.
   */
  impersonatedBy: UserRef | null;
  /** The impersonation it was recorded under, with the same visibility as impersonatedBy. */
  impersonationId: string | null;
  target: ActivityTargetDto;
  /**
   * Kind event: the event payload, allowlisted per type and redacted for
   * the viewer (correction notes, positions). Kind audit: { before, after },
   * allowlisted per action. Kind impersonation: {}. Empty when the target
   * is not available.
   */
  payload: Record<string, unknown>;
  /** Kind impersonation: the session window. null otherwise. */
  impersonation: ImpersonationDto | null;
  /** IP and user agent: the viewer's own access rows (tab access) and Admins only. */
  access: ActivityAccessDto | null;
  /**
   * The row is attributed to the account by an approximation (a change to
   * the permissions of a role it is assumed to have held then): show
   * `activity.approximateRole`.
   */
  approximate: boolean;
}

export interface ActivityPageDto {
  items: ActivityItemDto[];
  /** Pass as `cursor` for the next page; null on the last one. */
  nextCursor: string | null;
}

/** GET /api/me/activity response. */
export interface MeActivityPageDto extends ActivityPageDto {
  /**
   * Impersonations of this account started in the last
   * IMPERSONATION_NOTICE_DAYS days, newest first, whatever the tab: drives
   * the notice at the top of "Mi actividad".
   */
  recentImpersonations: ImpersonationDto[];
}

/**
 * GET /api/me/activity query, as parsed by meActivityQuerySchema. On the
 * wire, list filters repeat (`category=a&category=b`) or comma-separate.
 */
export interface MeActivityQuery {
  /** by | to | access | member (ME_ACTIVITY_TABS). `member` needs a linked member. */
  tab: MeActivityTab;
  /** Assembly slug ("80-ago") or id. */
  assembly?: string;
  category?: ActivityCategory[];
  /** Inclusive lower bound (ISO datetime with offset). */
  from?: IsoDate;
  /** Exclusive upper bound (ISO datetime with offset): the client sends the start of the next day. */
  to?: IsoDate;
  /** Opaque on the wire (the previous page's nextCursor); parsed into its position. */
  cursor?: ActivityCursor;
  /** 1..ME_ACTIVITY_MAX_LIMIT, default ACTIVITY_PAGE_DEFAULT_LIMIT. */
  limit: number;
}

/**
 * GET /api/admin/activity query (Admin only), as parsed by
 * adminActivityQuerySchema. Every filter is optional and they combine with
 * AND. On the wire, list filters repeat or comma-separate and booleans are
 * "1"/"true"/"0"/"false".
 */
export interface AdminActivityQuery {
  /** Done by this account (better-auth user id). */
  actor?: string;
  /** Done to this account: audit rows targeting it and impersonations of it. */
  target?: string;
  /** Either actor or target. */
  user?: string;
  /** Done while acting for this member (events.actor_member_id), or audit rows targeting it. */
  member?: string;
  /** Assembly slug or id. */
  assembly?: string;
  /** Exact event types or audit actions. */
  action?: string[];
  category?: ActivityCategory[];
  kind?: ActivityKind[];
  source?: AuditSource[];
  /** true: only rows done while impersonating; false: only rows that were not. */
  impersonated?: boolean;
  /** Only rows recorded under this impersonation (cuid2), plus its window. */
  impersonation?: string;
  /** Inclusive lower bound (ISO datetime with offset). */
  from?: IsoDate;
  /** Exclusive upper bound (ISO datetime with offset). */
  to?: IsoDate;
  /** Case-insensitive search over the actor's and target's name and email. */
  q?: string;
  /** Opaque on the wire (the previous page's nextCursor); parsed into its position. */
  cursor?: ActivityCursor;
  /** 1..ADMIN_ACTIVITY_MAX_LIMIT, default ACTIVITY_PAGE_DEFAULT_LIMIT. */
  limit: number;
}
