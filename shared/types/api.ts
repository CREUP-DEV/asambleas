/**
 * API contract shared by Nitro handlers and the Vue client. Dates travel as
 * ISO strings. See docs/api.md for the endpoints that return each shape.
 */
import type { AssemblyType } from "../constants/assemblyTypes";
import type {
  AcceptanceDecision,
  AcceptanceRole,
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
import type { AmendmentOp, Block, ChangeKind } from "./content";
import type { CalendarWarning } from "../utils/calendar";

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

export interface MeDto {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string | null;
  permissions: PermissionKey[];
  isAdmin: boolean;
  member: MemberRef | null;
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
  calendarWarnings: CalendarWarning[];
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
  acceptsSubmissions: boolean;
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
  updatedAt?: IsoDate;
}

export interface AgendaReorderBody {
  items: { id: string; parentId: string | null; order: number }[];
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
  proponent: MemberRef | null;
  amendable: boolean;
  voted: boolean;
  majority: Majority;
  amendmentCount: number;
  window: AmendmentWindowDto;
  publishedAt: IsoDate | null;
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
  publish: boolean;
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
  submittedAt: IsoDate | null;
  /** Only present for those who can edit, before publication. */
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
  proponentMemberId?: string | null;
  /** Defaults come from the kind. */
  amendable?: boolean;
  voted?: boolean;
  majority?: Majority;
  blocks?: Block[];
}

export interface DocumentUpdateBody {
  title?: string;
  summary?: string | null;
  kind?: DocumentKind;
  agendaItemId?: string;
  proponentMemberId?: string | null;
  amendable?: boolean;
  voted?: boolean;
  majority?: Majority;
  amendmentsOpenAt?: IsoDate | null;
  amendmentsCloseAt?: IsoDate | null;
  status?: "withdrawn" | "postponed" | "submitted";
  updatedAt: IsoDate;
}

export interface DocumentContentBody {
  blocks: Block[];
  /** contentHash of the working version the client edited. */
  baseHash: string;
}

export interface DocxImportDto {
  blocks: Block[];
  warnings: ("tracked_changes" | "comments" | "images_dropped")[];
}

// Amendments -------------------------------------------------------------

export interface AcceptanceDto {
  member: MemberRef;
  role: AcceptanceRole;
  decision: AcceptanceDecision;
  decidedAt: IsoDate | null;
}

export interface PositionDto {
  position: ProponentPosition;
  comment: string | null;
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
}

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
  authors: MemberRef[];
  submittedAt: IsoDate | null;
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
  updatedAt: IsoDate | null;
}

export interface LiveStateBody {
  agendaItemId?: string | null;
  documentId?: string | null;
  amendmentId?: string | null;
  voteId?: string | null;
  message?: string | null;
}

export interface EventDto {
  id: string;
  type: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  actorName: string | null;
  actorMember: MemberRef | null;
  createdAt: IsoDate;
}

/** Server-sent event pushed on GET /api/assemblies/[assembly]/live. */
export interface LiveEventDto {
  entityType: string;
  entityId: string;
  type: string;
  documentId?: string;
}
