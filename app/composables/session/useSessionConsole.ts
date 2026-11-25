import type { InjectionKey, MaybeRefOrGetter, Ref } from "vue";
import type { ElectionInput } from "~~/shared/utils/election";
import type {
  AdmissionBody,
  AgendaDto,
  AlternativesVoteBody,
  AlternativesVoteDto,
  BlocVoteBody,
  BlocVoteDto,
  AmendmentAdmissionDto,
  AmendmentDto,
  AmendmentOutcomeDto,
  BulkAssentBody,
  BulkAssentDto,
  BulkLapseBody,
  BulkLapseDto,
  ApprovalWarnings,
  AssemblyDto,
  DocumentAmendmentsDto,
  DocumentDto,
  FinalVoteAnnulBody,
  FinalVoteBody,
  ItemVoteBody,
  ItemVoteResultDto,
  ItemVotesDto,
  SessionProgressDto,
  LiveEventDto,
  LiveStateBody,
  LiveTally,
  LiveStateDto,
  OutcomeAction,
  PassageWordingBody,
  PassageWordingDto,
  PositionBody,
  PublishAmendmentsBody,
  RelationBody,
  RelationDto,
  SpeakingTurnDto,
  TransactionalBody,
  ValidateAmendmentsBody,
  VoteDto,
  VoteInput,
  VoteUnanimityBody,
  VoteVoidBody,
} from "~~/shared/types/api";
import type {
  AmendmentOp,
  ConsolidationConflict,
} from "~~/shared/types/content";
import type { ApprovalImpact, Passage } from "~~/shared/utils/content/passages";
import {
  DEFAULT_ASSEMBLY_SETTINGS,
  type AssemblySettings,
  type LiveBlocPurpose,
  type ProponentPosition,
} from "~~/shared/constants/domain";
import {
  isSessionInProgress,
  liveStateClearsOnly,
} from "~~/shared/utils/sessionGate";
import { useApi } from "../api/useApi";
import { useAlternativesVoteText } from "../vote/useAlternativesVoteText";
import type {
  AlternativesTieResolution,
  AlternativesWinnerOutcome,
} from "~~/shared/utils/alternativesVote";
import type { VoteBallotInput } from "~~/shared/utils/rollCall";
import { CURRENT_ASSEMBLY_KEY } from "../assembly/useCurrentAssembly";
import { cancelStaleRead } from "../fetch/cancelStaleRead";
import {
  keepLastGoodData,
  onlyForKey,
  useStaleDataNotice,
} from "../fetch/lastGoodData";
import { useAssemblyLive } from "../live/useAssemblyLive";
import { followLiveState } from "../live/-liveState";
import {
  affectsDocumentAmendments,
  affectsDocumentDto,
  keepsAgendaSummary,
} from "../assembly/-liveFilters";
import SessionConfirmDialog from "~/components/session/ConfirmDialog.vue";
import {
  buildSessionAgendaRows,
  buildSessionQueue,
  affectsSessionProgress,
  isSessionAwaitingValidation,
  isSessionBlocCandidate,
  isSessionIncorporated,
  isSessionOpen,
  isSessionPendingAdmission,
  isSessionPublishable,
  isSessionTransactable,
  openRoomAlternatives,
  sessionAmendmentStage,
  sessionAssentPlan,
  sessionBlocToggle,
  sessionCleanVote,
  sessionConnectionState,
  sessionApprovalImpact,
  sessionConsolidatedPreview,
  sessionErrorData,
  sessionErrorIds,
  sessionFinalVoteBlockers,
  sessionFinalVoteReasons,
  sessionLapseOffer,
  sessionLeavesPendingVote,
  sessionLiveMoved,
  sessionItemGoneThrough,
  sessionItemVotePlan,
  sessionNextAgendaTarget,
  sessionNextAmendmentId,
  sessionPendingTransactionalIds,
  sessionQueueCounts,
  sessionQueueOrder,
  sessionSettleConfirm,
  sessionValidationIds,
  type SessionAdmissionDecision,
  type SessionAgendaFlow,
  type SessionAgendaRow,
  type SessionAgendaTarget,
  type SessionAmendmentStage,
  type SessionLivePointer,
  type SessionSettleAction,
} from "./sessionModel";
import { agendaWithTitles } from "~/utils/agendaTitles";
import { numberedAgendaTitle } from "~/utils/agendaTree";
import { staleSheetRow } from "~/components/control-sheet/-model";
import { sessionMarkAction } from "~~/shared/utils/sessionProgress";
import { amendmentRule } from "~~/shared/utils/positions";
import { useHeadcounts } from "./useSessionHeadcounts";
import { useSessionSpeakers } from "./useSessionSpeakers";
import { useSessionTransactionalsOver } from "./useSessionTransactionalsOver";
import { useProjectionControl } from "./useProjectionControl";
import { latestTallySender } from "./liveTally";
import {
  sessionAdmissionProposal,
  sessionAdmissionTarget,
  sessionApprovalBloc,
  type SessionAdmissionProposal,
} from "./admissionProposal";

/**
 * Busy key of the "who sees the speaking turns" switch. It must not start
 * with "speaker-", the prefix the floor buttons wait for.
 */
export const SPEAKERS_VISIBLE_BUSY_KEY = "speakers-visible";

/** What the console's `confirm` shows (SessionConfirmDialog's props). */
/**
 * What a console without control of the projection works on: its own
 * agenda item, document and amendment (useSessionConsole's cursor).
 */
export interface SessionCursor {
  agendaItemId: string | null;
  documentId: string | null;
  amendmentId: string | null;
}

export interface SessionConfirmProps {
  title: string;
  description: string;
  items?: string[];
  confirmLabel: string;
  confirmIcon?: string;
  confirmColor?: "primary" | "warning" | "error";
}

export type SessionFinalVoteResult =
  | { ok: true; document: DocumentDto }
  | {
      ok: false;
      conflicts: ConsolidationConflict[];
      undecided: string[];
      tie: boolean;
      /** Passages the Mesa has not worded yet (consolidateApproved). */
      pendingPassages: Passage[];
    };

/** What recording an agenda item's vote came to, for its dialog. */
export type SessionItemVoteResult =
  | { ok: true; vote: VoteDto }
  | {
      ok: false;
      /** A tie the tie rule sends back to the vote: the dialog says so. */
      tie: boolean;
    };

/**
 * The `data.reason` of a failed request, nested by h3 under `data.data` or
 * at `data` (same nesting as errorReasonKey in useApi).
 */
function errorReason(error: unknown): string | null {
  const nested = sessionErrorData(error)?.reason;
  if (typeof nested === "string") return nested;
  const data =
    error && typeof error === "object"
      ? (error as { data?: unknown }).data
      : null;
  const reason =
    data && typeof data === "object"
      ? (data as { reason?: unknown }).reason
      : null;
  return typeof reason === "string" ? reason : null;
}

/** A document's amendments, tagged with the document they were fetched for. */
export type SessionAmendmentsDto = DocumentAmendmentsDto & {
  documentId: string;
};

export interface SessionLapseDialog {
  open: boolean;
  /** The amendment just decided. */
  targetId: string | null;
  lapse: string[];
}

/** The passage the wording dialog is open on (its key), if any. */
export interface SessionWordingDialog {
  open: boolean;
  passageKey: string | null;
  /** Open on the editor: a deletion that wins first asks whether to keep it. */
  editing: boolean;
}

/** How a one-click decision was asked for. */
export interface SettleOptions {
  /**
   * Taken by key on an amendment that is not the one in debate: its
   * confirmation says so too (one dialog with the transactional's, if any).
   */
  notDebated?: boolean;
}

/**
 * Wording and icon of the confirmation of each one-click decision. Only the
 * decisions a key takes (assent with "a", lapse with "l") have a
 * not-debated sentence: `notDebated` is ignored for the others.
 */
const SETTLE_CONFIRM: Record<
  SessionSettleAction,
  { label: string; icon: string; notDebated?: string }
> = {
  assent: {
    label: "session.now.assent",
    icon: "i-lucide-check",
    notDebated: "session.shortcuts.notDebatedAssent",
  },
  formal: {
    label: "session.actions.formal",
    icon: "i-lucide-spell-check",
  },
  withdraw: {
    label: "session.actions.withdraw",
    icon: "i-lucide-undo-2",
  },
  lapse: {
    label: "session.actions.lapse",
    icon: "i-lucide-circle-slash",
    notDebated: "session.shortcuts.notDebatedLapse",
  },
  incorporate: {
    label: "amendment.position.options.accept",
    icon: "i-lucide-thumbs-up",
  },
};

interface OutcomeOptions {
  /** Offer to lapse what the decision leaves without object. Default true. */
  offer?: boolean;
  /** Show a toast with an undo action. Default true. */
  toast?: boolean;
}

/**
 * State and actions of the Mesa session console for one assembly: the
 * assembly, its agenda and live state, the document on screen and its
 * amendments, plus every mutation the Mesa can run. Live events refetch only
 * what changed. The page provides it to the session components through
 * `provideSessionConsole`.
 */
export function useSessionConsole(assemblyParam: MaybeRefOrGetter<string>) {
  const api = useApi();
  const toast = useToast();
  const { t } = useI18n();
  const alternativesText = useAlternativesVoteText();

  // Inside the assembly hub (app/pages/asambleas/[assembly].vue) the hub
  // already holds the assembly and the one live stream of the tab; on its
  // own the console fetches and listens by itself.
  const hub = inject(CURRENT_ASSEMBLY_KEY, null);

  const param = computed(() => toValue(assemblyParam));
  const assemblyUrl = computed(() =>
    hub?.assembly.value
      ? hub.apiBase.value
      : `/api/assemblies/${encodeURIComponent(param.value)}`,
  );

  // Data ----------------------------------------------------------------------

  // Every fetch below keeps its last good data when a refresh fails (venue
  // Wi-Fi, a server restart), so the console never empties mid-session.
  const standalone = hub
    ? null
    : useFetch<AssemblyDto>(() => assemblyUrl.value, {
        key: computed(() => `assembly-${param.value}`),
      });
  const standaloneAssembly = standalone
    ? keepLastGoodData(standalone, { resetOn: param })
    : null;

  const assembly = computed<AssemblyDto | null>(
    () => (hub ? hub.assembly.value : standaloneAssembly?.data.value) ?? null,
  );
  const assemblyPending = computed(() =>
    hub ? hub.pending.value : standalone?.status.value === "pending",
  );
  const refreshAssembly = (): Promise<void> =>
    hub ? hub.refresh() : (standalone?.refresh() ?? Promise.resolve());

  const agendaFetch = useAsyncData(
    () => `session-agenda-${param.value}`,
    () => api.get<AgendaDto>(`${assemblyUrl.value}/agenda`),
  );
  const {
    status: agendaStatus,
    error: agendaError,
    refresh: refreshAgenda,
  } = agendaFetch;
  const { data: fetchedAgenda, stale: agendaStale } = keepLastGoodData(
    agendaFetch,
    { resetOn: param },
  );
  // An item sent without its title gets a neutral one (titleHidden).
  const agenda = agendaWithTitles(fetchedAgenda, () => t("agenda.hiddenTitle"));

  /**
   * The live state in order (`updatedAt`): pushed on the stream after each
   * move of the Mesa (onLiveState), read on a poll, a reconnection, a
   * change of the vote on screen or when no push covered a batch, and
   * answered by this console's own changes (setLive).
   */
  const liveFollower = followLiveState({
    apply: (state) => {
      liveState.value = state;
    },
  });
  if (getCurrentScope()) onScopeDispose(liveFollower.dispose);
  const liveFetch = useAsyncData(
    () => `session-live-${param.value}`,
    () =>
      api
        .get<LiveStateDto>(`${assemblyUrl.value}/live-state`)
        .then((state) => liveFollower.fetched(state) ?? state),
  );
  const { status: liveStatus, refresh: refreshLive } = liveFetch;
  const { data: liveState, stale: liveStale } = keepLastGoodData(liveFetch, {
    resetOn: param,
  });
  liveFollower.fetched(liveState.value ?? null);

  // Control of the projection (user's decision of 2026-11-19) -------------------

  /**
   * One console tab of the Mesa controls what is on screen
   * (useProjectionControl). Every other console works on its own: its debate
   * actions move only its own `cursor`, and what it records goes on no
   * screen (the server decides that, whatever the console sends).
   */
  const control = useProjectionControl(assemblyUrl);
  const inControl = computed(() => control.inControl.value);

  /**
   * What this console works on without control: an agenda item, a document
   * and an amendment of its own. Null follows the projection (a console
   * that has not moved on its own, or went back to what is on screen).
   */
  const cursor = ref<SessionCursor | null>(null);
  // Losing control, or gaining it: back to following what is on screen.
  watch(inControl, () => {
    cursor.value = null;
  });

  /**
   * What the console works on, shaped like the live state: the projection
   * itself with control, else this console's cursor over it (the vote on
   * screen only while the cursor is where the projection is).
   */
  const debate = computed<LiveStateDto | null>(() => {
    const live = liveState.value ?? null;
    const own = cursor.value;
    if (inControl.value || !own || !live) return live;
    const onScreen =
      own.agendaItemId === live.agendaItemId &&
      own.documentId === live.documentId &&
      own.amendmentId === live.amendmentId;
    // A bloc is only projected with control: away from the screen there is
    // none (SessionCursor carries no bloc).
    return {
      ...live,
      agendaItemId: own.agendaItemId,
      documentId: own.documentId,
      amendmentId: own.amendmentId,
      amendmentBloc: onScreen ? live.amendmentBloc : [],
      amendmentBlocOptions: onScreen ? live.amendmentBlocOptions : null,
      amendmentBlocPurpose: onScreen ? live.amendmentBlocPurpose : null,
      vote: onScreen ? live.vote : null,
      voteDecision: onScreen ? live.voteDecision : null,
    };
  });
  /** This console works on something else than what is on screen. */
  const awayFromScreen = computed(() => {
    const live = liveState.value;
    const own = debate.value;
    if (inControl.value || !live || !own) return false;
    return (
      own.agendaItemId !== live.agendaItemId ||
      own.documentId !== live.documentId ||
      own.amendmentId !== live.amendmentId
    );
  });
  /** Back to what is on screen, following it from now on. */
  function followScreen(): void {
    cursor.value = null;
    const id = liveState.value?.documentId;
    if (id) documentId.value = id;
  }
  /** Takes control of the projection: the console follows what is on it. */
  async function takeControl(): Promise<boolean> {
    const ok = await control.take();
    if (ok) followScreen();
    return ok;
  }

  const settings = computed<AssemblySettings>(() => ({
    ...DEFAULT_ASSEMBLY_SETTINGS,
    ...(assembly.value?.settings ?? {}),
  }));
  const canModerate = computed(() => assembly.value?.can.moderate ?? false);
  /**
   * The session is open: only then does the Mesa project or record
   * anything (shared/utils/sessionGate.ts; the server refuses it too).
   */
  const inSession = computed(() => isSessionInProgress(assembly.value?.status));

  const agendaRows = computed(() =>
    buildSessionAgendaRows(
      agenda.value?.items ?? [],
      agenda.value?.documents ?? [],
    ),
  );
  /**
   * The document the console shows. It follows the one in debate; with
   * nothing in debate it shows none until the Mesa opens one from the
   * agenda (never a document picked for it, which read as if it were in
   * debate before the session opened).
   */
  const documentId = ref<string | null>(null);

  watch(
    () => debate.value?.documentId ?? null,
    (id) => {
      if (id) documentId.value = id;
    },
    { immediate: true },
  );

  // Another agenda item in debate without a document: the document of the
  // item left (or one opened from the agenda) goes too (user's decision of
  // 2026-11-19), so the console never shows the previous item's text.
  watch(
    () => debate.value?.agendaItemId ?? null,
    (itemId, previous) => {
      if (itemId === previous || previous === undefined) return;
      if (!debate.value?.documentId) documentId.value = null;
    },
  );

  const documentUrl = computed(() =>
    documentId.value
      ? `${assemblyUrl.value}/documents/${encodeURIComponent(documentId.value)}`
      : null,
  );

  const documentFetch = useAsyncData(
    () => `session-document-${documentId.value ?? "none"}`,
    () =>
      documentUrl.value
        ? api.get<DocumentDto>(documentUrl.value)
        : Promise.resolve(null),
  );
  const {
    status: documentStatus,
    error: documentError,
    refresh: refreshDocument,
  } = documentFetch;
  // Switching documents forgets the kept one: it must never stand in for
  // the document now under debate.
  const { data: fetchedDocument, stale: documentStale } = keepLastGoodData(
    documentFetch,
    { resetOn: documentId },
  );
  // Nor may the previous document's DTO, which Nuxt carries into the new
  // key's entry until it loads: the panels show their loading state, so no
  // final vote typed for the old document reaches the new one's URL.
  const document = onlyForKey(
    fetchedDocument,
    documentId,
    (fetched) => fetched.id,
  );

  const amendmentsFetch = useAsyncData(
    () => `session-amendments-${documentId.value ?? "none"}`,
    async (): Promise<SessionAmendmentsDto | null> => {
      // Tagged with the document it was fetched for: the DTO carries no
      // document id, and an empty list would say nothing either.
      const forDocument = documentId.value;
      const url = documentUrl.value;
      if (!forDocument || !url) return null;
      const dto = await api.get<DocumentAmendmentsDto>(`${url}/amendments`);
      return { ...dto, documentId: forDocument };
    },
  );
  const {
    status: amendmentsStatus,
    error: amendmentsError,
    refresh: refreshAmendments,
  } = amendmentsFetch;
  const { data: fetchedAmendments, stale: amendmentsStale } = keepLastGoodData(
    amendmentsFetch,
    { resetOn: documentId },
  );
  // The previous document's list, carried like its DTO, would count its
  // undecided amendments (or none) against the new document.
  const amendmentsDto = onlyForKey(
    fetchedAmendments,
    documentId,
    (fetched) => fetched.documentId,
  );

  // One shared "showing the last data received" toast (same id as the hub).
  useStaleDataNotice(
    computed(
      () =>
        agendaStale.value ||
        liveStale.value ||
        documentStale.value ||
        amendmentsStale.value ||
        Boolean(standaloneAssembly?.stale.value),
    ),
  );

  const amendments = computed(() => amendmentsDto.value?.amendments ?? []);
  const relations = computed(() => amendmentsDto.value?.relations ?? []);
  /** The Mesa's wordings of passages where approved amendments collide. */
  const wordings = computed(() => amendmentsDto.value?.wordings ?? []);
  const byId = computed(
    () =>
      new Map(amendments.value.map((amendment) => [amendment.id, amendment])),
  );
  const base = computed(() => document.value?.baseVersion?.blocks ?? []);
  /** The pending transactionals over an amendment, in words (SES-3). */
  const transactionalsOver = useSessionTransactionalsOver(byId);
  /**
   * What an amendment the main presenter accepts becomes in this document:
   * "incorporate" puts it in the text at once, without a vote.
   */
  const incorporatesAccepted = computed(
    () => document.value?.acceptedAmendments === "incorporate",
  );

  /** Short label of an amendment: its code, or "#n" before it has one. */
  function label(id: string): string {
    const amendment = byId.value.get(id);
    if (!amendment) {
      // A passage the Mesa worded reads «Mesa» in the consolidated text.
      return wordings.value.some((wording) => wording.id === id)
        ? t("session.wording.code")
        : "?";
    }
    return amendment.code ?? (amendment.number ? `#${amendment.number}` : "?");
  }

  /**
   * Where an amendment stands in the session (sessionAmendmentStage), with
   * the document's other amendments, so a transactional another one got
   * ahead of reads as superseded.
   */
  function stageOf(amendment: AmendmentDto): SessionAmendmentStage {
    return sessionAmendmentStage(amendment, byId.value);
  }

  // Queue ---------------------------------------------------------------------

  const hideDecided = ref(false);
  // Grouped by the main presenter's answers as the Mesa reads them
  // (accepted, rejected, the rest), public or not yet (user's decision of
  // 2026-11-19).
  const queue = computed(() =>
    buildSessionQueue(amendments.value, { byAnswer: true }),
  );
  const isVisible = (amendment: AmendmentDto) =>
    !hideDecided.value || amendment.status === "submitted";
  const queueOrder = computed(() => sessionQueueOrder(queue.value, isVisible));
  const queueCounts = computed(() => sessionQueueCounts(amendments.value));
  // Every submitted amendment, validated or not: it mirrors what the final
  // vote still waits for.
  const undecided = computed(() =>
    amendments.value.filter((amendment) => amendment.status === "submitted"),
  );
  // The same, split by who has to act: the Mesa, the assembly (late ones),
  // the main authors of what a transactional replaces, or the Secretaría.
  const finalVoteBlockers = computed(() =>
    sessionFinalVoteBlockers(amendments.value),
  );
  const preview = computed(() =>
    sessionConsolidatedPreview(base.value, amendments.value, wordings.value),
  );
  /** Passages the Mesa still has to word before the final vote. */
  const pendingPassages = computed(() =>
    preview.value.passages.filter((passage) => passage.status === "pending"),
  );
  /**
   * What approving an undecided amendment does to the approved text, for the
   * notice before deciding it (sessionApprovalImpact).
   */
  function impactOf(amendment: AmendmentDto): ApprovalImpact | null {
    return sessionApprovalImpact(
      base.value,
      amendments.value,
      amendment,
      wordings.value,
    );
  }
  const assentPlan = computed(() => sessionAssentPlan(amendments.value));

  // Bloc (user's decision of 2026-11-19) ---------------------------------------

  /**
   * «Seleccionar para bloque»: the Mesa ticks, in the main queue, the
   * amendments it proposes to approve together (isSessionBlocCandidate,
   * accepted or not), puts them on screen as a bloc and approves them by
   * assent. Local to this console, and gone when it shows another document.
   */
  const blocMode = ref(false);
  const blocSelection = ref<string[]>([]);
  /** The row last clicked, where a shift-click range starts. */
  const blocAnchor = ref<string | null>(null);
  /**
   * The rows that can be ticked, in the order the queue lists them: those
   * of the main list only, never of a group that changes the same passage
   * (debated one by one) nor late ones (user's decision of 2026-11-19).
   */
  const blocOrder = computed(() =>
    queue.value.entries
      .map((entry) => (entry.type === "amendment" ? entry.amendment : null))
      .filter(
        (amendment): amendment is AmendmentDto =>
          amendment !== null &&
          isVisible(amendment) &&
          isSessionBlocCandidate(amendment) &&
          // A transactional that can no longer go ahead is only withdrawn.
          stageOf(amendment) !== "superseded",
      )
      .map((amendment) => amendment.id),
  );
  /** The selection, without what was decided since (from any console). */
  const blocSelected = computed(() => {
    const ids = new Set(blocSelection.value);
    return blocOrder.value.filter((id) => ids.has(id));
  });
  watch(documentId, () => {
    blocMode.value = false;
    blocSelection.value = [];
    blocAnchor.value = null;
  });
  /** Ticks or unticks a row; with shift, the range from the last one. */
  function toggleBloc(id: string, range = false): void {
    blocSelection.value = sessionBlocToggle(
      blocSelected.value,
      blocOrder.value,
      id,
      { anchor: blocAnchor.value, range },
    );
    blocAnchor.value = id;
  }
  /** «Las aceptadas»: what the accepted shortcut would approve. */
  function selectAcceptedBloc(): void {
    blocSelection.value = assentPlan.value.ready.map(
      (amendment) => amendment.id,
    );
    blocAnchor.value = null;
  }
  function clearBlocSelection(): void {
    blocSelection.value = [];
    blocAnchor.value = null;
  }
  function cancelBloc(): void {
    clearBlocSelection();
    blocMode.value = false;
  }
  /**
   * The bloc on screen proposed for approval, for the document the console
   * shows; empty without one, while this console looks at another document,
   * or for a proposal on admission (sessionApprovalBloc).
   */
  const blocOnScreen = computed<string[]>(() =>
    sessionApprovalBloc(debate.value, documentId.value),
  );
  /**
   * A proposal to admit late amendments or not on screen, for the document
   * the console shows (user's decision of 2026-11-21); null otherwise.
   */
  const proposalOnScreen = computed<SessionAdmissionProposal | null>(() =>
    sessionAdmissionProposal(debate.value, documentId.value),
  );
  /**
   * The proposal on admission the room has on screen for this document,
   * whatever this console follows: what the admission dialog decides.
   */
  const roomProposal = computed<SessionAdmissionProposal | null>(() =>
    sessionAdmissionProposal(liveState.value, documentId.value),
  );
  /** Why the final vote cannot be recorded yet (empty when it can). */
  const finalVoteReasons = computed(() =>
    sessionFinalVoteReasons({
      document: document.value ?? null,
      amendmentsLoaded: Boolean(amendmentsDto.value),
      blockers: finalVoteBlockers.value,
      // Passages still to word no longer hold the vote back: the final
      // vote may leave them pending conciliation (user's decisions of
      // 2026-11-21); the console offers their wording beside it.
    }),
  );

  // What is under debate ----------------------------------------------------------

  /**
   * The console shows the document in debate unless a Mesa member picked
   * another one in the agenda to look at: then what is debated may not be
   * in the loaded list.
   */
  const showingLiveDocument = computed(
    () =>
      !debate.value?.documentId || debate.value.documentId === documentId.value,
  );
  /** The amendment under debate, when the console has it loaded. */
  const debatedAmendment = computed<AmendmentDto | null>(() => {
    const id = debate.value?.amendmentId;
    if (!id || !showingLiveDocument.value) return null;
    return byId.value.get(id) ?? null;
  });
  /** What "Siguiente" debates: the next amendment the Mesa can decide. */
  const nextAmendment = computed<AmendmentDto | null>(() => {
    if (!showingLiveDocument.value || !debate.value?.documentId) {
      return null;
    }
    const id = sessionNextAmendmentId(
      queue.value,
      debate.value.amendmentId ?? null,
    );
    return id ? (byId.value.get(id) ?? null) : null;
  });
  /**
   * How the agenda is gone through around an item voted as a whole: its
   * own vote (pending or recorded) and the items gone through (treated, or
   * with a document that has been on screen), read when the next item is
   * worked out (sessionNextAgendaTarget).
   */
  const agendaFlow: SessionAgendaFlow = {
    vote: (row) => {
      if (!row.item.voted) return null;
      const plan = sessionItemVotePlan(
        row,
        itemVotes.value,
        assembly.value?.status,
      );
      if (!plan.takesVote) return null;
      return plan.vote ? "recorded" : "pending";
    },
    goneThrough: (row) => itemGoneThrough(row),
  };
  /**
   * The agenda item after the one in debate, with its only document; after
   * the sub-items of an item voted as a whole, back to it to vote it.
   */
  const nextAgendaTarget = computed(() =>
    sessionNextAgendaTarget(
      agendaRows.value,
      debate.value?.agendaItemId ?? null,
      agendaFlow,
    ),
  );

  /** Goes back to the document under debate after looking at another one. */
  function followLive(): void {
    const id = debate.value?.documentId;
    if (id) documentId.value = id;
  }

  /**
   * The amendment the keyboard shortcuts act on. One the Secretaría has not
   * validated yet is never a target: the Mesa cannot decide it.
   */
  const focusedId = ref<string | null>(null);
  const focused = computed(() => {
    const amendment = focusedId.value
      ? (byId.value.get(focusedId.value) ?? null)
      : null;
    return amendment && !isSessionAwaitingValidation(amendment)
      ? amendment
      : null;
  });

  /** Moves the page focus to an amendment's card, wherever it now sits. */
  function focusCard(id: string): void {
    if (!import.meta.client) return;
    void nextTick(() => {
      window.document.getElementById(`session-amendment-${id}`)?.focus();
    });
  }

  // Another document clears the target, except the one in debate, whose
  // debated amendment stays the target (the watcher below may run first
  // when the debate jumps to another document).
  watch(documentId, (id) => {
    const live = debate.value;
    focusedId.value =
      id && live?.documentId === id ? (live.amendmentId ?? null) : null;
  });

  /**
   * The shortcuts follow the debate: when it moves on (from this device or
   * another), the amendment now debated becomes their target, or none when
   * the debate is cleared, whatever row had been selected or has the DOM
   * focus. `focused` resolves the id once its document's amendments arrive.
   */
  watch(
    () => debate.value?.amendmentId ?? null,
    (id) => {
      focusedId.value = id;
    },
  );

  /** Moves the keyboard focus through the queue (j/k). */
  function moveFocus(step: 1 | -1): string | null {
    const order = queueOrder.value;
    if (order.length === 0) return null;
    const index = focusedId.value ? order.indexOf(focusedId.value) : -1;
    const next =
      index === -1
        ? step > 0
          ? 0
          : order.length - 1
        : Math.min(order.length - 1, Math.max(0, index + step));
    focusedId.value = order[next] ?? null;
    return focusedId.value;
  }

  /** Mutations in flight, by amendment id or action name. */
  const busy = ref<Record<string, boolean>>({});

  /**
   * Whether the session is open, saying so when it is not: the buttons that
   * project or record are disabled then, and this stops what a menu, a
   * shortcut or a dialog left open would still send.
   */
  function requireInSession(): boolean {
    if (inSession.value) return true;
    toast.add({
      id: "session-not-open",
      title: t("session.notInSession"),
      description: t("common.errors.sessionNotOpen"),
      color: "warning",
      icon: "i-lucide-lock",
    });
    return false;
  }

  async function track<T>(key: string, run: () => Promise<T>): Promise<T> {
    busy.value = { ...busy.value, [key]: true };
    try {
      return await run();
    } finally {
      busy.value = Object.fromEntries(
        Object.entries(busy.value).filter(([other]) => other !== key),
      );
    }
  }

  // Speaking turns ------------------------------------------------------------

  const speakers = useSessionSpeakers({
    baseUrl: assemblyUrl,
    key: param,
    enabled: canModerate,
    track,
  });

  // Headcounts: the latest one is the base of majorities on "present".
  const headcounts = useHeadcounts({
    baseUrl: assemblyUrl,
    key: param,
    enabled: canModerate,
    track,
  });
  /**
   * The latest headcount for the vote forms (undefined until loaded). They
   * open with "present" empty, so it is the base of majorities on "present"
   * (sessionFillPresent, as the server's fillPresent) until the Mesa types
   * another figure.
   */
  const voteHeadcount = computed(() =>
    headcounts.data.value ? headcounts.latest.value : undefined,
  );

  // Agenda item votes: the votes on agenda items themselves (a
  // ratification, an election), voided ones too, from which the item in
  // debate reads its vote in force. Only the Mesa reads them, as itself:
  // never with the room view. A failed read keeps the last good list; with
  // none, the item offers its vote without a status line.
  const itemVotesFetch = useAsyncData(
    () => `session-item-votes-${param.value}`,
    () =>
      canModerate.value
        ? api.get<ItemVotesDto>(`${assemblyUrl.value}/item-votes`)
        : Promise.resolve(null),
    { server: false, watch: [canModerate] },
  );
  const { data: itemVotesDto } = keepLastGoodData(itemVotesFetch, {
    resetOn: param,
  });
  const itemVotes = computed<VoteDto[]>(() => itemVotesDto.value?.votes ?? []);

  function refreshItemVotes(): Promise<void> {
    return itemVotesFetch.refresh();
  }

  // How far the session has gone: the documents projected and where each
  // item stands (the control sheet's rule; the Mesa's mark is set when the
  // Mesa presents an item, and undone or set again from here). The Mesa
  // only, as itself; a failed read keeps the last good marks, and with none
  // the console marks nothing.
  const progressFetch = useAsyncData(
    () => `session-progress-${param.value}`,
    () =>
      canModerate.value
        ? api.get<SessionProgressDto>(`${assemblyUrl.value}/session-progress`)
        : Promise.resolve(null),
    { server: false, watch: [canModerate] },
  );
  const { data: progressDto } = keepLastGoodData(progressFetch, {
    resetOn: param,
  });
  const projectedDocumentIds = computed(
    () => new Set(progressDto.value?.projectedDocumentIds ?? []),
  );
  /**
   * Where each agenda item stands, by the control sheet's own rule
   * (sessionTreatedItems on the server): treated or not and why, whether it
   * waits for a vote, and the mark's token.
   */
  const itemTreatments = computed(
    () =>
      new Map(
        (progressDto.value?.items ?? []).map((entry) => [entry.id, entry]),
      ),
  );
  const treatedItemIds = computed(
    () =>
      new Set(
        (progressDto.value?.items ?? [])
          .filter((entry) => entry.treated)
          .map((entry) => entry.id),
      ),
  );

  /**
   * The Mesa has gone through the item: treated, or one of its documents
   * has been on screen (an item presented while it waited for a vote is
   * never marked treated).
   */
  function itemGoneThrough(row: SessionAgendaRow): boolean {
    return sessionItemGoneThrough(
      row,
      treatedItemIds.value,
      projectedDocumentIds.value,
    );
  }

  function refreshProgress(): Promise<void> {
    return progressFetch.refresh();
  }

  // The Mesa's speaking turns follow the agenda item in debate, and the
  // progress marks a document projected the first time it goes on screen
  // (without an event of its own): both are read again only when the live
  // state moves to another item or document, not on every move of the
  // debate (sessionLiveMoved). Watching the live state itself catches a
  // move this console stored from its own request as well as one read on
  // a live event.
  watch(
    (): SessionLivePointer | undefined =>
      liveState.value
        ? {
            documentId: liveState.value.documentId,
            agendaItemId: liveState.value.agendaItemId,
          }
        : undefined,
    (next, previous) => {
      const moved = sessionLiveMoved(previous, next);
      if (moved.speakers) void speakers.refresh();
      if (moved.progress) void refreshProgress();
    },
  );

  /** Where an agenda item stands in the session, or null while unknown. */
  function itemTreatment(itemId: string) {
    return itemTreatments.value.get(itemId) ?? null;
  }

  /**
   * Whether the Mesa can set (`mark`) or undo (`unmark`) the treated mark
   * of an item from the console (sessionMarkAction): undo a mark, the one
   * left on an item now waiting for a vote included, set it only on an item
   * neither treated nor waiting for a vote.
   */
  function itemMarkAction(itemId: string): "mark" | "unmark" | null {
    if (!canModerate.value) return null;
    const entry = itemTreatment(itemId);
    return entry ? sessionMarkAction(entry) : null;
  }

  /**
   * Sets or undoes the Mesa's treated mark of an item, as the control sheet
   * does (PATCH .../control-sheet/items/[item], with the mark's token): a
   * mark someone changed meanwhile reads again and says so.
   */
  async function setItemTreated(
    itemId: string,
    value: boolean,
  ): Promise<boolean> {
    const key = `treated-${itemId}`;
    if (busy.value[key]) return false;
    const token = itemTreatment(itemId)?.token ?? null;
    busy.value = { ...busy.value, [key]: true };
    try {
      await api.send(
        `${assemblyUrl.value}/control-sheet/items/${encodeURIComponent(itemId)}`,
        {
          method: "PATCH",
          body: { treated: { value, updatedAt: token } },
        },
      );
      return true;
    } catch (error) {
      if (staleSheetRow(error)) {
        toast.add({
          title: t("controlSheet.panel.stale"),
          color: "warning",
          icon: "i-lucide-refresh-ccw",
        });
      } else {
        api.notifyError(error, "session.progress.markFailed");
      }
      return false;
    } finally {
      const { [key]: _done, ...rest } = busy.value;
      busy.value = rest;
      await refreshProgress();
    }
  }

  /**
   * Where a document stands in the session: `treated` once its own item
   * (its automatic sub-item, or the item it hangs from) reads treated,
   * `projected` once the Mesa put it on screen, else null.
   */
  function documentProgress(
    documentId: string,
  ): "treated" | "projected" | null {
    const owner = agenda.value?.documents.find(
      (entry) => entry.id === documentId,
    );
    if (owner && treatedItemIds.value.has(owner.agendaItemId)) return "treated";
    return projectedDocumentIds.value.has(documentId) ? "projected" : null;
  }

  /**
   * Puts a vote a mutation returned in the list, replacing its old copy;
   * a read that left before it never brings the old copy back (CON-10).
   */
  function storeItemVote(vote: VoteDto): void {
    const current = itemVotesDto.value?.votes ?? [];
    const index = current.findIndex((other) => other.id === vote.id);
    const next = [...current];
    if (index === -1) next.push(vote);
    else next[index] = vote;
    itemVotesDto.value = { votes: next };
    cancelStaleRead(itemVotesFetch);
  }

  // Live updates --------------------------------------------------------------

  function refreshAll(): Promise<unknown> {
    return Promise.all([
      refreshAssembly(),
      refreshAgenda(),
      refreshLive(),
      refreshDocument(),
      refreshAmendments(),
      speakers.refresh(),
      headcounts.refresh(),
      refreshItemVotes(),
      refreshProgress(),
    ]);
  }

  function onLive(events: LiveEventDto[]): void {
    speakers.onLive(events);
    headcounts.onLive(events);
    if (events.some((event) => event.type === "poll")) {
      // Changes were missed, maybe a restart: ask who holds control now,
      // and put the open form's count back on screen.
      void control.refresh().then(resendFormTally);
      // The hub refreshes the assembly itself on poll events.
      void (hub
        ? Promise.all([
            refreshAgenda(),
            refreshLive(),
            refreshDocument(),
            refreshAmendments(),
            refreshItemVotes(),
            refreshProgress(),
          ])
        : refreshAll());
      return;
    }
    const current = documentId.value;
    const finalVoteId = document.value?.finalVote?.id ?? null;
    let live = false;
    let assemblyChanged = false;
    let agendaChanged = false;
    let amendmentsChanged = false;
    let itemVotesChanged = false;
    let progressChanged = false;
    const projectedVoteId = liveState.value?.vote?.id ?? null;
    // Control of the projection moved: this console asks who holds it now.
    if (events.some((event) => event.entityType === "projection")) {
      void control.refresh();
    }
    // Not on every vote or answer of one of its amendments: only what may
    // change the DocumentDto (affectsDocumentDto), its final vote's
    // unanimity included.
    const documentChanged = affectsDocumentDto(events, current, finalVoteId);
    // A move of the Mesa came pushed (onLiveState) unless no push covered
    // it; the speakers and the progress follow it either way (the watch on
    // the live state, sessionLiveMoved).
    const livePushed = statePushed();
    for (const event of events) {
      if (event.entityType === "live" && !livePushed) live = true;
      // The Mesa ticks an item in the sheet, or a document, the agenda or
      // a vote the sheet's rule reads changes how an item stands
      // (affectsSessionProgress); the live state moving to another
      // document or item is watched apart (sessionLiveMoved).
      if (affectsSessionProgress(event, finalVoteId)) progressChanged = true;
      if (event.entityType === "vote") {
        // A vote with no document is an agenda item's (recorded, voided or
        // made unanimous, here or from the control sheet).
        if (!event.documentId) itemVotesChanged = true;
        // The vote on screen changed without the live state moving (its
        // unanimity): read the live state again for its new copy.
        if (event.entityId === projectedVoteId) live = true;
      }
      if (event.entityType === "assembly") {
        assemblyChanged = true;
        agendaChanged = true;
      }
      if (
        event.entityType === "agenda_item" ||
        (event.entityType === "document" && !keepsAgendaSummary(event))
      ) {
        agendaChanged = true;
      }
      // As the room reads it (affectsDocumentAmendments): its document, and
      // the assembly opening or closing, which changes what may be done.
      const touchesCurrent = affectsDocumentAmendments([event], current);
      if (touchesCurrent) amendmentsChanged = true;
    }
    if (live) void refreshLive();
    if (assemblyChanged && !hub) void refreshAssembly();
    if (agendaChanged) void refreshAgenda();
    if (documentChanged) void refreshDocument();
    if (amendmentsChanged) void refreshAmendments();
    if (itemVotesChanged) void refreshItemVotes();
    if (progressChanged) void refreshProgress();
  }

  let connected: Readonly<Ref<boolean>>;
  let polling: Readonly<Ref<boolean>>;
  let statePushed: () => boolean;
  if (hub) {
    hub.onLive(onLive);
    hub.onLiveState(liveFollower.pushed);
    ({ connected, polling, statePushed } = hub.live);
  } else {
    ({ connected, polling, statePushed } = useAssemblyLive(
      () => assembly.value?.id,
      onLive,
      { onState: liveFollower.pushed },
    ));
  }

  // Until the first connection is ready the console is connecting, not
  // offline: the badge must not alarm the Mesa while the page opens.
  const everConnected = ref(false);
  watch(
    connected,
    (isConnected) => {
      if (isConnected) everConnected.value = true;
    },
    { immediate: true },
  );
  const connection = computed(() =>
    sessionConnectionState(connected.value, polling.value, everConnected.value),
  );

  /**
   * Reads again what this console's own change touched besides what its
   * answer brought, unless the live stream is connected: the change's own
   * event then makes onLive read it some 300 ms later (and replaces a read
   * that started before the change), so reading it now as well only made
   * the server build it twice. Without the stream, where the next poll
   * may be 15 s away, it reads it at once.
   */
  function refreshUnlessLive(...refreshes: (() => Promise<unknown>)[]): void {
    if (connected.value) return;
    for (const refresh of refreshes) void refresh();
  }

  // Local updates ---------------------------------------------------------------

  /**
   * Stores a list of amendments a mutation answered with, if the console
   * still shows its document. A read of the list that left before the
   * mutation would land after it and put decided amendments back to
   * pending: it is replaced by one that leaves now (CON-10), unless the
   * caller reads the list again itself right after (`rereads`).
   */
  function storeAmendmentList(
    next: SessionAmendmentsDto,
    options: { rereads?: boolean } = {},
  ): void {
    if (next.documentId !== documentId.value) return;
    amendmentsDto.value = next;
    if (!options.rereads) cancelStaleRead(amendmentsFetch);
  }

  /**
   * Puts fresh amendments in the local list, so their updatedAt is current:
   * one write and at most one read for a whole batch (a bloc, the
   * alternatives, a bulk approval).
   */
  function upsertAmendments(
    updated: readonly AmendmentDto[],
    options: { rereads?: boolean } = {},
  ): void {
    const current = amendmentsDto.value;
    if (!current) return;
    const mine = updated.filter(
      (amendment) => amendment.documentId === documentId.value,
    );
    if (mine.length === 0) return;
    const next = [...current.amendments];
    for (const amendment of mine) {
      const index = next.findIndex((other) => other.id === amendment.id);
      if (index === -1) next.push(amendment);
      else next[index] = amendment;
    }
    storeAmendmentList({ ...current, amendments: next }, options);
  }

  /** Puts a fresh amendment in the local list, so its updatedAt is current. */
  function upsertAmendment(amendment: AmendmentDto): void {
    upsertAmendments([amendment]);
  }

  /**
   * Stores a document a mutation returned, only if the console still shows
   * it: another Mesa member may have moved the debate (and the console with
   * it) while the request was in flight, and the fetch key now points at
   * the new document's entry. A read that left before the mutation never
   * brings the old one back (CON-10).
   */
  function storeDocument(updated: DocumentDto): void {
    if (updated.id !== documentId.value) return;
    document.value = updated;
    cancelStaleRead(documentFetch);
  }

  function documentApi(path = ""): string {
    return `${documentUrl.value ?? ""}${path}`;
  }

  function onConflict(error: unknown): void {
    if (api.isConflict(error)) {
      void refreshAmendments();
      void refreshDocument();
    }
  }

  // Live state ------------------------------------------------------------------

  /**
   * Changes the live state. `key` is the busy key it holds: "live" (what is
   * debated, which the debate buttons wait for) unless the change is
   * something else, such as who sees the speaking turns.
   */
  async function setLive(
    body: LiveStateBody,
    options: { silent?: boolean; key?: string } = {},
  ): Promise<boolean> {
    if (!liveStateClearsOnly(body) && !requireInSession()) return false;
    try {
      const answer = await track(options.key ?? "live", () =>
        api.send<LiveStateDto>(`${assemblyUrl.value}/live-state`, {
          method: "PUT",
          body,
        }),
      );
      // A push of a later change may have come first: it stays.
      liveState.value = liveFollower.fetched(answer) ?? answer;
      return true;
    } catch (error) {
      if (!options.silent) api.notifyError(error, "session.errors.live");
      return false;
    }
  }

  /**
   * Moves what the console debates: with control, what is on screen (the
   * live state); without it, only this console's cursor, with the same
   * rules (a document brings its agenda item, another document drops the
   * amendment). Nothing is sent then, so the session need not be open.
   */
  async function moveDebate(body: LiveStateBody): Promise<boolean> {
    if (inControl.value) {
      if (!(await confirmLeavingVote(body))) return false;
      return setLive(body);
    }
    const from = debate.value;
    const next: SessionCursor = {
      agendaItemId: from?.agendaItemId ?? null,
      documentId: from?.documentId ?? null,
      amendmentId: from?.amendmentId ?? null,
    };
    if (body.agendaItemId !== undefined) next.agendaItemId = body.agendaItemId;
    if (body.documentId !== undefined) {
      if (body.documentId !== next.documentId) next.amendmentId = null;
      next.documentId = body.documentId;
      const owner = body.documentId
        ? agenda.value?.documents.find((entry) => entry.id === body.documentId)
        : undefined;
      if (owner && body.agendaItemId === undefined) {
        next.agendaItemId = owner.agendaItemId;
      }
    }
    if (body.amendmentId !== undefined) next.amendmentId = body.amendmentId;
    cursor.value = next;
    return true;
  }

  /**
   * Leaving an agenda item whose vote is not recorded yet asks first, on
   * the console that presents (user's decision of 2026-11-20): the item
   * stays pending until its vote is recorded (sessionLeavesPendingVote).
   */
  async function confirmLeavingVote(body: LiveStateBody): Promise<boolean> {
    if (body.agendaItemId === undefined) return true;
    const fromId = liveState.value?.agendaItemId ?? null;
    const leaves = sessionLeavesPendingVote(
      agenda.value?.items ?? [],
      (itemId) => itemTreatment(itemId)?.awaitingVote ?? false,
      fromId,
      body.agendaItemId,
    );
    if (!leaves) return true;
    const row = agendaRows.value.find((entry) => entry.item.id === fromId);
    const item = row
      ? numberedAgendaTitle(
          row.number,
          row.item.title,
          t("agenda.unlisted.inText"),
        )
      : "";
    return confirm({
      title: t("session.leaveVote.title"),
      description: t("session.leaveVote.description", { item }),
      confirmLabel: t("session.leaveVote.confirm"),
      confirmIcon: "i-lucide-skip-forward",
      confirmColor: "warning",
    });
  }

  function debateAgendaItem(itemId: string): Promise<boolean> {
    return moveDebate({
      agendaItemId: itemId,
      documentId: null,
      amendmentId: null,
      voteId: null,
    });
  }

  async function debateDocument(target: {
    id: string;
    agendaItemId: string;
  }): Promise<boolean> {
    const ok = await moveDebate({
      agendaItemId: target.agendaItemId,
      documentId: target.id,
      amendmentId: null,
      voteId: null,
    });
    if (ok) {
      documentId.value = target.id;
      documentScrolls.value++;
    }
    return ok;
  }

  function debateAmendment(amendment: AmendmentDto): Promise<boolean> {
    return moveDebate({
      documentId: amendment.documentId,
      amendmentId: amendment.id,
      voteId: null,
    });
  }

  /**
   * Puts an amendment under debate from its card, its row or "Siguiente".
   * Debating shows it on the projection, and the projection shows only
   * public amendments (the server answers 409 otherwise):
   * - one that is validated but private asks first, and whoever can publish
   *   it makes it public and debates it in one go;
   * - anyone else is told the Secretaría has to publish it, and nothing is
   *   sent.
   * Moving the debate to another document than the one the room follows
   * asks first too: the projection and every attendee move with it.
   */
  async function requestDebate(amendment: AmendmentDto): Promise<boolean> {
    const fresh = byId.value.get(amendment.id) ?? amendment;
    // Without control nothing goes on screen: no publication, nothing to ask.
    if (!inControl.value) return debateAmendment(fresh);
    const code = label(fresh.id);
    const isPrivate = fresh.publishedAt === null;
    if (isPrivate && !isSessionPublishable(fresh)) {
      toast.add({
        id: `session-debate-private-${fresh.id}`,
        title: t("session.debateConfirm.needsPublish", { code }),
        color: "info",
        icon: "i-lucide-eye-off",
      });
      return false;
    }
    const liveDocument = liveState.value?.documentId ?? null;
    const otherDocument =
      liveDocument !== null && liveDocument !== fresh.documentId;
    const moveHint = otherDocument
      ? t("session.debateConfirm.otherDocument")
      : null;
    if (isPrivate) {
      const confirmed = await confirm({
        title: t("session.debateConfirm.title", { code }),
        description: [t("session.debateConfirm.description"), moveHint]
          .filter(Boolean)
          .join(" "),
        confirmLabel: t("session.debateConfirm.publishAndDebate"),
        confirmIcon: "i-lucide-eye",
      });
      if (!confirmed) return false;
      if (!(await publishAmendments([fresh.id]))) return false;
    } else if (moveHint) {
      const confirmed = await confirm({
        title: t("session.debateConfirm.otherDocumentTitle", { code }),
        description: moveHint,
        confirmLabel: t("session.debateConfirm.moveDebate"),
        confirmIcon: "i-lucide-radio",
      });
      if (!confirmed) return false;
    }
    return debateAmendment(byId.value.get(fresh.id) ?? fresh);
  }

  function clearDebatedAmendment(): Promise<boolean> {
    return moveDebate({ amendmentId: null, voteId: null });
  }

  /**
   * Takes the document out of the debate and keeps its agenda item: the
   * console goes back to the item, with its documents and the next item.
   * Clearing the item too would offer the first agenda item again.
   */
  function clearDebatedDocument(): Promise<boolean> {
    return moveDebate({ documentId: null, amendmentId: null, voteId: null });
  }

  /**
   * Ends the debate: nothing stays under debate, so the console offers the
   * first agenda item again and attendees see that nothing is debated.
   */
  function clearDebate(): Promise<boolean> {
    return moveDebate({
      agendaItemId: null,
      documentId: null,
      amendmentId: null,
      voteId: null,
    });
  }

  /**
   * Puts a bloc on screen («Se propone aprobar en bloque»; with a purpose,
   * «Se propone admitir a debate» or «Se propone no admitir»), in place of
   * the amendment or the vote on it. Only the console in control, on the
   * document on screen (or none yet): moving the room to another document
   * asks first, as debating an amendment of it does.
   */
  async function projectBloc(
    ids: string[],
    /**
     * A proposal to admit late amendments or not instead (user's decision
     * of 2026-11-21): published ones pending admission.
     */
    purpose: LiveBlocPurpose | null = null,
  ): Promise<boolean> {
    if (!inControl.value || ids.length === 0) return false;
    const liveDocument = liveState.value?.documentId ?? null;
    if (liveDocument !== null && liveDocument !== documentId.value) {
      const confirmed = await confirm({
        title: t("session.bloc.otherDocumentTitle"),
        description: t("session.debateConfirm.otherDocument"),
        confirmLabel: t("session.debateConfirm.moveDebate"),
        confirmIcon: "i-lucide-radio",
      });
      if (!confirmed) return false;
    }
    return setLive({
      amendmentBloc: ids,
      amendmentBlocPurpose: purpose,
      amendmentId: null,
      voteId: null,
    });
  }

  /**
   * Takes the bloc, or the proposal on admission, off the screen; the
   * document stays.
   */
  function unprojectBloc(): Promise<boolean> {
    return setLive({ amendmentBloc: null });
  }

  /**
   * "Siguiente": debates the next amendment the Mesa can decide and makes
   * it the target of the keyboard shortcuts.
   */
  async function debateNext(): Promise<boolean> {
    const next = nextAmendment.value;
    if (!next) return false;
    const ok = await requestDebate(next);
    if (ok) focusedId.value = next.id;
    return ok;
  }

  /** Moves the debate to an agenda item and, if it has one, its document. */
  function debateAgendaTarget(target: SessionAgendaTarget): Promise<boolean> {
    return target.document
      ? debateDocument(target.document)
      : debateAgendaItem(target.row.item.id);
  }

  /**
   * Whether attendees see who has the floor and who is next. It holds its
   * own busy key: flipping it must not hold up the debate buttons.
   */
  function setSpeakersVisible(visible: boolean): Promise<boolean> {
    return setLive(
      { speakersVisible: visible },
      { key: SPEAKERS_VISIBLE_BUSY_KEY },
    );
  }

  function setMessage(message: string | null): Promise<boolean> {
    return setLive({ message: message?.trim() ? message.trim() : null });
  }

  /**
   * Calls a recess, or changes when it resumes (an ISO instant, or null when
   * the Mesa does not say); null ends it. The projection shows it.
   */
  function setRecess(
    recess: { until: string | null } | null,
  ): Promise<boolean> {
    return setLive({ recess }, { key: "recess" });
  }

  /**
   * A secret vote's running count for the projection (POST .../live-tally),
   * at most every TALLY_SEND_MS, the last one always; null ends it at once.
   * Memory only on the server: the vote is recorded as usual once counted.
   */
  const TALLY_SEND_MS = 120;
  let tallyTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingTally: LiveTally | null = null;
  /**
   * What the open vote form announces, whoever controls the projection:
   * sent again once this console may show it (resendFormTally).
   */
  let formTally: LiveTally | null = null;
  // One POST at a time, in order, the latest waiting one only: a count sent
  // after the null that ended it would put it back on screen.
  const postTally = latestTallySender((tally) =>
    api.send(`${assemblyUrl.value}/live-tally`, {
      method: "POST",
      body: { tally },
    }),
  );
  function sendTally(): void {
    tallyTimer = undefined;
    postTally(pendingTally);
  }
  function pushTally(tally: LiveTally | null): void {
    formTally = tally;
    // Only the console in control shows the count (the server ignores the
    // rest), so another console's form never clears it either.
    if (!inControl.value) return;
    pendingTally = tally;
    if (tally === null) {
      clearTimeout(tallyTimer);
      sendTally();
      return;
    }
    if (!tallyTimer) tallyTimer = setTimeout(sendTally, TALLY_SEND_MS);
  }
  /**
   * The server keeps the count in memory only, and lets only the console
   * in control show it: once this console gets control, or after the
   * stream missed changes (a restart forgets both the count and who holds
   * control) and its beat says it holds it again, the open form's count
   * goes back on screen at once instead of at the form's next repeat.
   */
  function resendFormTally(): void {
    // Not while saving (most likely this vote): its result would be
    // covered again; the form's repeat sends it later.
    if (Object.values(busy.value).some(Boolean)) return;
    if (formTally && inControl.value) pushTally(formTally);
  }
  watch(inControl, (now) => {
    if (now) resendFormTally();
  });
  // A tab closed or reloaded mid-count ends it on screen at once (the form
  // never unmounts then), instead of after LIVE_TALLY_TTL_MS; a tab back
  // from the browser's page cache puts it back.
  useEventListener("pagehide", () => {
    if (!formTally || !inControl.value) return;
    api
      .send(`${assemblyUrl.value}/live-tally`, {
        method: "POST",
        body: { tally: null },
        keepalive: true,
      })
      .catch(() => undefined);
  });
  useEventListener("pageshow", (event: PageTransitionEvent) => {
    if (event.persisted) resendFormTally();
  });

  /** The default limit of a speaking turn, in seconds. */
  function setSpeakingLimit(seconds: number): Promise<boolean> {
    return setLive(
      { speakingLimitSeconds: seconds },
      { key: "speaking-limit" },
    );
  }

  // Votes on the projection are the server's job: it points the live state at
  // every vote it records (and at what was voted) and clears it when that
  // vote is voided (amendment reopened, final vote annulled), recording a
  // `live_changed` event that onLive picks up. The console never sends a
  // voteId after a vote: a late request could put a voided result back on
  // screen.

  // Dialogs ---------------------------------------------------------------------

  const voteDialog = reactive({
    open: false,
    amendmentId: null as string | null,
  });
  const relationDialog = reactive({
    open: false,
    amendmentId: null as string | null,
  });
  const admissionDialog = reactive({
    open: false,
    ids: [] as string[],
    decision: "admitted" as SessionAdmissionDecision,
  });
  const composer = reactive({ open: false, sourceIds: [] as string[] });
  const finalVoteDialog = reactive({ open: false });
  const finalVoteAnnulDialog = reactive({ open: false });
  /**
   * Approval by assent of several amendments: those of `ids`, as
   * sessionAssentPlan plans them, from the accepted shortcut (`bloc`
   * false, prefilled with the accepted ones) or from a bloc the Mesa picked
   * or has on screen.
   */
  const assentDialog = reactive({
    open: false,
    ids: [] as string[],
    bloc: false,
    /** It approves the bloc on screen (roomBlocOpen), whatever opened it. */
    onScreen: false,
  });
  // The shortcut keeps its whole plan: the accepted ones held back say why.
  const assentDialogPlan = computed(() =>
    assentDialog.bloc
      ? sessionAssentPlan(amendments.value, assentDialog.ids)
      : assentPlan.value,
  );
  /**
   * The bloc the room has on screen for this document, still open, whatever
   * this console follows (one without control has no bloc in its own
   * `debate`): what the room was asked to approve.
   */
  const roomBlocOpen = computed<string[]>(() => {
    // Never a proposal on admission: admitted, its amendments are open, and
    // approving them is not what the room was asked (sessionApprovalBloc).
    return sessionApprovalBloc(liveState.value, documentId.value).filter(
      (id) => {
        const amendment = byId.value.get(id);
        return amendment !== undefined && isSessionOpen(amendment);
      },
    );
  });
  /**
   * Opens it on the accepted ones (the shortcut), or on a bloc. While a bloc
   * is on screen with amendments still open, every way in approves that one
   * (user's decision of 2026-11-20): in the 80.ª AGO a console approved its
   * own selection of 17 while the room read a bloc of 12 on screen.
   */
  function openAssent(ids?: string[]): void {
    // Alternatives on screen are decided by voting between them: approving
    // them all would approve both options (the server refuses it too).
    if (roomAlternatives.value) {
      toast.add({
        id: "session-assent-alternatives",
        title: t("session.alternatives.assentBlocked"),
        color: "warning",
        icon: "i-lucide-scale",
      });
      return;
    }
    const target = roomBlocOpen.value.length > 0 ? roomBlocOpen.value : ids;
    assentDialog.ids =
      target ?? assentPlan.value.ready.map((amendment) => amendment.id);
    assentDialog.bloc = target !== undefined;
    assentDialog.onScreen = roomBlocOpen.value.length > 0;
    assentDialog.open = true;
  }
  /**
   * The bloc on screen as alternatives to vote between, while it is this
   * document's and any of them is still open (openRoomAlternatives): each
   * option's amendments (user's decision of 2026-11-20).
   */
  const roomAlternatives = computed<string[][] | null>(() => {
    const state = liveState.value;
    if (!state || state.documentId !== documentId.value) return null;
    return openRoomAlternatives(state.amendmentBlocOptions, byId.value);
  });
  /**
   * The dialog of a vote on a bloc (user's decision of 2026-11-21): one
   * vote, every amendment approved or every one rejected.
   */
  const blocVoteDialog = reactive({ open: false, ids: [] as string[] });
  /**
   * Opens it on the bloc chosen; while a bloc is on screen, on that one,
   * as approving by assent does (roomBlocOpen). Never on alternatives on
   * screen: those are voted between.
   */
  function openBlocVote(ids: string[]): void {
    if (!requireInSession()) return;
    if (roomAlternatives.value) {
      toast.add({
        id: "session-bloc-vote-alternatives",
        title: t("session.alternatives.assentBlocked"),
        color: "warning",
        icon: "i-lucide-scale",
      });
      return;
    }
    const target = roomBlocOpen.value.length > 0 ? roomBlocOpen.value : ids;
    blocVoteDialog.ids = target.filter((id) => {
      const amendment = byId.value.get(id);
      return amendment !== undefined && isSessionOpen(amendment);
    });
    blocVoteDialog.open = true;
  }
  /** Records the vote on the bloc; false when it was not recorded. */
  async function voteBloc(ids: string[], vote: VoteInput): Promise<boolean> {
    if (!requireInSession()) return false;
    const body: BlocVoteBody = {
      items: ids.map((id) => ({
        id,
        updatedAt: byId.value.get(id)?.updatedAt ?? "",
      })),
      vote,
      project: inControl.value,
    };
    try {
      const result = await track("bloc-vote", () =>
        api.send<BlocVoteDto>(documentApi("/amendments/bloc-vote"), { body }),
      );
      // The read right after replaces any read on its way (cancel).
      upsertAmendments(result.amendments, { rereads: true });
      void refreshAmendments();
      const approved = result.decision.vote?.result === "approved";
      toast.add({
        id: `session-bloc-vote-${result.decision.id}`,
        title: approved
          ? t("session.blocVote.approved", { count: ids.length }, ids.length)
          : t("session.blocVote.rejected", { count: ids.length }, ids.length),
        color: approved ? "success" : "warning",
        icon: "i-lucide-check",
      });
      cancelBloc();
      const first = result.amendments.find(
        (amendment) => amendment.status === "approved",
      );
      if (first) offerLapses(first, result.warnings);
      return true;
    } catch (error) {
      if (sessionErrorData(error)?.tie === true) {
        toast.add({
          id: "session-bloc-vote-tie",
          title: t("session.vote.tieTitle"),
          description: t("session.vote.tieRepeat"),
          color: "warning",
          icon: "i-lucide-scale",
        });
        return false;
      }
      api.notifyError(error, "session.blocVote.errors.record");
      return false;
    }
  }
  /** The dialog of a vote between alternatives, on the amendments chosen. */
  const alternativesDialog = reactive({
    open: false,
    ids: [] as string[],
    /** The options it starts with: those on screen, if any. */
    options: null as string[][] | null,
  });
  /**
   * Opens it on the bloc chosen; while alternatives are on screen, on
   * those, split as they are.
   */
  function openAlternatives(ids: string[]): void {
    if (!requireInSession()) return;
    const onScreen = roomAlternatives.value;
    alternativesDialog.ids = onScreen ? onScreen.flat() : [...ids];
    alternativesDialog.options = onScreen
      ? onScreen.map((option) => [...option])
      : null;
    alternativesDialog.open = true;
  }
  /** Puts the options on screen, as a bloc split in alternatives. */
  async function projectAlternatives(options: string[][]): Promise<boolean> {
    if (!inControl.value || options.some((ids) => ids.length === 0)) {
      return false;
    }
    const liveDocument = liveState.value?.documentId ?? null;
    if (liveDocument !== null && liveDocument !== documentId.value) {
      const confirmed = await confirm({
        title: t("session.bloc.otherDocumentTitle"),
        description: t("session.debateConfirm.otherDocument"),
        confirmLabel: t("session.debateConfirm.moveDebate"),
        confirmIcon: "i-lucide-radio",
      });
      if (!confirmed) return false;
    }
    return setLive({
      amendmentBloc: options.flat(),
      amendmentBlocOptions: options,
      amendmentId: null,
      voteId: null,
    });
  }
  /**
   * Records a vote between alternatives. Without a winner and without the
   * Mesa's choice it answers `undecided` and records nothing: the dialog
   * then offers rejecting them all, repeating, or leaving them undecided.
   */
  async function voteAlternatives(input: {
    method: AlternativesVoteBody["method"];
    options: { ids: string[]; count: number }[];
    abstentions: number;
    blank: number;
    invalid: number;
    present: number | null;
    note: string | null;
    tieResolution?: AlternativesTieResolution;
    winnerOutcome?: AlternativesWinnerOutcome;
    /** A registered vote: each delegation's ballot. */
    ballots?: VoteBallotInput[];
    rollCallHeadcountId?: string;
  }): Promise<
    | { ok: true; vote: VoteDto }
    | { ok: false; undecided: "tie" | "short" | null }
  > {
    if (!requireInSession()) return { ok: false, undecided: null };
    const body: AlternativesVoteBody = {
      method: input.method,
      options: input.options.map((option) => ({
        items: option.ids.map((id) => ({
          id,
          updatedAt: byId.value.get(id)?.updatedAt ?? "",
        })),
        count: option.count,
      })),
      ...(input.method === "secret"
        ? { blank: input.blank, invalid: input.invalid }
        : { abstentions: input.abstentions }),
      present: input.present,
      note: input.note,
      ...(input.tieResolution ? { tieResolution: input.tieResolution } : {}),
      ...(input.winnerOutcome ? { winnerOutcome: input.winnerOutcome } : {}),
      ...(input.method === "roll_call" && (input.ballots?.length ?? 0) > 0
        ? {
            ballots: input.ballots,
            ...(input.rollCallHeadcountId
              ? { rollCallHeadcountId: input.rollCallHeadcountId }
              : {}),
          }
        : {}),
      project: inControl.value,
    };
    try {
      const result = await track("alternatives", () =>
        api.send<AlternativesVoteDto>(documentApi("/amendments/alternatives"), {
          body,
        }),
      );
      upsertAmendments(result.amendments);
      refreshUnlessLive(refreshAmendments);
      const vote = result.decision.vote!;
      toast.add({
        id: `session-alternatives-${result.decision.id}`,
        title: t("session.alternatives.recorded"),
        description: alternativesText.outcome(vote),
        color: "success",
        icon: "i-lucide-check",
      });
      cancelBloc();
      const approved = result.amendments.find(
        (amendment) => amendment.status === "approved",
      );
      if (approved) offerLapses(approved, result.warnings);
      return { ok: true, vote };
    } catch (error) {
      const data = sessionErrorData(error);
      if (data?.tie === true) {
        return {
          ok: false,
          undecided: data.undecided === "short" ? "short" : "tie",
        };
      }
      api.notifyError(error, "session.alternatives.errors.record");
      return { ok: false, undecided: null };
    }
  }
  const lapseDialog = reactive<SessionLapseDialog>({
    open: false,
    targetId: null,
    lapse: [],
  });
  const wordingDialog = reactive<SessionWordingDialog>({
    open: false,
    passageKey: null,
    editing: false,
  });
  // The amendment just approved whose passage the Mesa words once the lapse
  // dialog, if any, is closed.
  const wordingAfterLapse = ref<string | null>(null);
  // Kept here, like every dialog, so anyDialogOpen pauses the shortcuts
  // while a name is being corrected (focus may be on a button, not a field).
  const speakerRenameDialog = reactive({
    open: false,
    turn: null as SpeakingTurnDto | null,
  });
  // The headcount form too: its checkboxes and close button are buttons,
  // which defineShortcuts does not skip.
  const headcountDialog = reactive({ open: false });
  /** The grid that writes down who asks for the floor. */
  const speakerAddDialog = reactive({ open: false });
  /**
   * The Mesa's pointer on the document on screen, shared by the document
   * preview (which draws and sends) and the bar stuck on top of the debate
   * column (which offers the controls while the preview scrolls by):
   * `available` while the preview shows the live document in session,
   * `clears` counts «Borrar trazos». On a text document (`text`) the Mesa
   * draws or selects words (`mode`), which the projection highlights.
   */
  const pointerTools = reactive({
    available: false,
    text: false,
    on: false,
    mode: "draw" as "draw" | "select",
    pinned: false,
    clears: 0,
  });
  /**
   * Counts the documents this console put in debate: the debate column
   * then scrolls to the document's start, the card folded into the bar on
   * top (user's decision of 2026-11-19; SessionAmendmentQueue).
   */
  const documentScrolls = ref(0);
  /** The vote on an agenda item, for the item it was opened on. */
  const itemVoteDialog = reactive({
    open: false,
    agendaItemId: null as string | null,
  });

  // The document follows the live state, which another Mesa member can move.
  // A document-level dialog left open would then record or annul the final
  // vote of a document the Mesa did not open it for.
  watch(documentId, () => {
    finalVoteDialog.open = false;
    finalVoteAnnulDialog.open = false;
    // Its amendments are the previous document's (a vote's count on the
    // projection ends with its form).
    assentDialog.open = false;
    voteDialog.open = false;
    alternativesDialog.open = false;
  });
  // Likewise the item vote: once the debate moves to another item (from
  // any Mesa device), it must not record a vote on the one the room left.
  watch(
    () => debate.value?.agendaItemId ?? null,
    (id) => {
      if (itemVoteDialog.open && id !== itemVoteDialog.agendaItemId) {
        itemVoteDialog.open = false;
      }
    },
  );

  /** A confirmation (SessionConfirmDialog) is on screen. */
  const confirmOpen = ref(false);
  const overlay = useOverlay();

  /**
   * Asks a yes-or-no question in a modal and resolves with the answer. One
   * at a time: a second request while one is open answers no.
   */
  async function confirm(props: SessionConfirmProps): Promise<boolean> {
    if (confirmOpen.value) return false;
    confirmOpen.value = true;
    try {
      const modal = overlay.create(SessionConfirmDialog, {
        destroyOnClose: true,
      });
      return (await modal.open(props)) === true;
    } finally {
      confirmOpen.value = false;
    }
  }

  /**
   * Asks before a one-click decision when it needs it (sessionSettleConfirm):
   * a pending transactional over the amendment would be withdrawn with it,
   * or it was taken by key on an amendment that is not the one in debate.
   * One dialog for both. True when nothing needs asking or it was confirmed.
   */
  async function confirmSettling(
    amendment: AmendmentDto,
    action: SessionSettleAction,
    options: SettleOptions = {},
  ): Promise<boolean> {
    const wording = SETTLE_CONFIRM[action];
    const notDebatedKey = options.notDebated ? wording.notDebated : undefined;
    const pendingCount = sessionPendingTransactionalIds(
      amendment,
      byId.value,
    ).length;
    const plan = sessionSettleConfirm({
      notDebated: Boolean(notDebatedKey),
      pendingTransactionals: pendingCount,
    });
    if (!plan) return true;
    const code = amendment.code ?? t("amendment.unnumberedLabel");
    const sentences = plan.parts.map((part) =>
      part === "not_debated" && notDebatedKey
        ? t(notDebatedKey, { code })
        : (transactionalsOver.consequence(amendment) ?? ""),
    );
    return confirm({
      title:
        plan.title === "not_debated"
          ? t("session.shortcuts.notDebatedTitle", { code })
          : t(
              "session.transactionalOver.confirmTitle",
              { code, count: pendingCount },
              pendingCount,
            ),
      description: sentences.filter(Boolean).join(" "),
      confirmLabel: t(wording.label),
      confirmIcon: wording.icon,
      confirmColor: plan.color,
    });
  }

  /**
   * Runs a one-click decision once confirmed (confirmSettling), on the
   * amendment as it is then: another Mesa device may have decided it, or a
   * request for it may be in flight, while the dialog was open.
   */
  async function settle<T>(
    amendment: AmendmentDto,
    action: SessionSettleAction,
    options: SettleOptions,
    allowed: (fresh: AmendmentDto) => boolean,
    run: (fresh: AmendmentDto) => Promise<T | null>,
  ): Promise<T | null> {
    const before = byId.value.get(amendment.id) ?? amendment;
    if (!allowed(before)) return null;
    if (!(await confirmSettling(before, action, options))) return null;
    const fresh = byId.value.get(amendment.id) ?? before;
    if (busy.value[fresh.id] || !allowed(fresh)) return null;
    return run(fresh);
  }

  const anyDialogOpen = computed(
    () =>
      confirmOpen.value ||
      voteDialog.open ||
      relationDialog.open ||
      admissionDialog.open ||
      composer.open ||
      finalVoteDialog.open ||
      finalVoteAnnulDialog.open ||
      assentDialog.open ||
      alternativesDialog.open ||
      blocVoteDialog.open ||
      lapseDialog.open ||
      wordingDialog.open ||
      speakerRenameDialog.open ||
      speakerAddDialog.open ||
      headcountDialog.open ||
      itemVoteDialog.open,
  );

  function openVote(amendment: AmendmentDto): void {
    if (!requireInSession()) return;
    voteDialog.amendmentId = amendment.id;
    voteDialog.open = true;
  }

  /** Opens the vote on an agenda item (the one in debate). */
  function openItemVote(itemId: string): void {
    if (!requireInSession()) return;
    itemVoteDialog.agendaItemId = itemId;
    itemVoteDialog.open = true;
  }

  function openRelation(amendment: AmendmentDto): void {
    relationDialog.amendmentId = amendment.id;
    relationDialog.open = true;
  }

  /**
   * Opens the admission dialog: `ids` are preselected, and are listed even
   * when they are not pending admission (an on-time amendment to declare
   * inadmissible, an inadmissible one to re-admit).
   */
  function openAdmission(
    ids: string[],
    decision: SessionAdmissionDecision,
  ): void {
    // A proposal on admission the room has on screen (whatever this console
    // follows) is what the dialog decides when opened on any of it.
    const target = sessionAdmissionTarget(
      ids,
      decision,
      roomProposal.value,
      byId.value,
    );
    admissionDialog.ids = target.ids;
    admissionDialog.decision = target.decision;
    admissionDialog.open = true;
  }

  /** Opens the transactional composer over the sources it can take. */
  function openComposer(sourceIds: string[]): void {
    // The Mesa's transactional is presented in the room.
    if (!requireInSession()) return;
    composer.sourceIds = sourceIds.filter((id) => {
      const amendment = byId.value.get(id);
      return amendment ? isSessionTransactable(amendment) : false;
    });
    composer.open = true;
  }

  /** Opens the dialog that corrects the person's name of a speaking turn. */
  function openSpeakerRename(turn: SpeakingTurnDto): void {
    speakerRenameDialog.turn = turn;
    speakerRenameDialog.open = true;
  }

  // Outcomes ----------------------------------------------------------------------

  const SUCCESS_KEYS: Record<OutcomeAction["action"], string> = {
    approve: "session.toasts.approved",
    vote: "session.toasts.voted",
    withdraw: "session.toasts.withdrawn",
    lapse: "session.toasts.lapsed",
    reopen: "session.toasts.reopened",
  };

  async function runOutcome(
    amendment: AmendmentDto,
    action: OutcomeAction,
    options: OutcomeOptions = {},
  ): Promise<AmendmentOutcomeDto | null> {
    // Reopening corrects the record; every other outcome is decided in the
    // room.
    if (action.action !== "reopen" && !requireInSession()) return null;
    const fresh = byId.value.get(amendment.id) ?? amendment;
    try {
      const result = await track(amendment.id, () =>
        api.send<AmendmentOutcomeDto>(
          documentApi(
            `/amendments/${encodeURIComponent(amendment.id)}/outcome`,
          ),
          { body: { ...action, updatedAt: fresh.updatedAt } },
        ),
      );
      upsertAmendment(result.amendment);
      // Approving a transactional changes its sources; reopening may give
      // them back. The change's own live event reads them again.
      if (
        result.amendment.kind === "transactional" ||
        action.action === "reopen"
      ) {
        refreshUnlessLive(refreshAmendments);
      }

      if (options.toast !== false) {
        const code = result.amendment.code ?? label(result.amendment.id);
        const resultKey =
          action.action === "vote"
            ? result.amendment.status === "approved"
              ? "session.toasts.voteApproved"
              : "session.toasts.voteRejected"
            : SUCCESS_KEYS[action.action];
        toast.add({
          id: `session-outcome-${result.amendment.id}`,
          title: t(resultKey, { code }),
          color: result.amendment.status === "rejected" ? "warning" : "success",
          icon: "i-lucide-check",
          actions:
            action.action === "reopen"
              ? undefined
              : [
                  {
                    label: t("session.actions.undo"),
                    color: "neutral",
                    variant: "outline",
                    onClick: () => {
                      void reopen(result.amendment);
                    },
                  },
                ],
        });
      }

      if (options.offer !== false) {
        offerLapses(result.amendment, result.warnings);
        // It now shares a passage with approved ones: the Mesa words it,
        // or sees the deletion that wins (user's decisions of 2026-11-19).
        if (
          result.amendment.status === "approved" &&
          (result.warnings?.overlapsWithApproved.length ?? 0) > 0
        ) {
          wordingAfterLapse.value = result.amendment.id;
        }
      }
      return result;
    } catch (error) {
      if (sessionErrorData(error)?.tie === true) {
        toast.add({
          id: `session-tie-${amendment.id}`,
          title: t("session.vote.tieTitle"),
          description: t("session.vote.tieRepeat"),
          color: "warning",
          icon: "i-lucide-scale",
        });
        return null;
      }
      api.notifyError(error, "session.errors.outcome");
      onConflict(error);
      return null;
    }
  }

  function offerLapses(
    target: AmendmentDto,
    warnings: ApprovalWarnings | null,
  ): void {
    const offer = sessionLapseOffer(
      target,
      amendments.value,
      relations.value,
      warnings,
    );
    if (offer.lapse.length === 0) return;
    lapseDialog.targetId = target.id;
    lapseDialog.lapse = offer.lapse;
    lapseDialog.open = true;
  }

  // Wordings ------------------------------------------------------------------

  /** Opens the wording dialog on a passage of the consolidated text. */
  function openWording(passage: Passage, editing = false): void {
    wordingDialog.passageKey = passage.key;
    // What the engine settled on its own (a deletion that wins, a merge)
    // opens to be read first; a passage to word opens in the editor.
    wordingDialog.editing =
      editing ||
      (passage.status !== "automatic" && passage.status !== "merged");
    wordingDialog.open = true;
  }

  // After an approval, once the lapse dialog is out of the way, the passage
  // the amendment joined.
  watch(
    [wordingAfterLapse, () => lapseDialog.open, preview],
    ([id, lapseOpen]) => {
      if (!id || lapseOpen || wordingDialog.open) return;
      const passage = preview.value.passages.find((item) =>
        item.amendmentIds.includes(id),
      );
      if (!passage) return;
      wordingAfterLapse.value = null;
      if (passage.status !== "worded") openWording(passage);
    },
  );

  /** Sets the Mesa's wording of a passage (PUT .../wordings). */
  async function setWording(
    passage: Pick<Passage, "amendmentIds" | "blockIds">,
    ops: AmendmentOp[],
  ): Promise<boolean> {
    try {
      const body: PassageWordingBody = {
        amendmentIds: passage.amendmentIds,
        blockIds: passage.blockIds,
        ops,
      };
      await track("wording", () =>
        api.send<PassageWordingDto>(documentApi("/wordings"), {
          method: "PUT",
          body,
        }),
      );
      await refreshAmendments();
      toast.add({
        title: t("session.wording.saved"),
        color: "success",
        icon: "i-lucide-pen-line",
      });
      return true;
    } catch (error) {
      api.notifyError(error, "session.errors.wording");
      onConflict(error);
      void refreshAmendments();
      return false;
    }
  }

  /** Removes a wording: the passage goes back to the automatic proposal. */
  async function removeWording(wordingId: string): Promise<boolean> {
    try {
      await track(`wording-${wordingId}`, () =>
        api.send(documentApi(`/wordings/${encodeURIComponent(wordingId)}`), {
          method: "DELETE",
        }),
      );
      await refreshAmendments();
      return true;
    } catch (error) {
      api.notifyError(error, "session.errors.wording");
      onConflict(error);
      return false;
    }
  }

  /**
   * Approves by assent or as a formal correction ("de forma"), asking first
   * when a pending transactional over it would be withdrawn
   * (confirmSettling). Nothing is sent once it is no longer open.
   */
  function approve(
    amendment: AmendmentDto,
    method: "assent" | "proponent" | "formal",
    options: SettleOptions = {},
  ) {
    return settle(
      amendment,
      method === "proponent" ? "incorporate" : method,
      options,
      isSessionOpen,
      (fresh) => runOutcome(fresh, { action: "approve", method }),
    );
  }

  function vote(amendment: AmendmentDto, input: VoteInput) {
    return runOutcome(amendment, { action: "vote", vote: input });
  }

  // The outcome endpoint settles only what the Mesa can decide now:
  // validated and admitted. Nothing is lapsed before the Secretaría
  // validates it or while the assembly has not agreed to treat it. Both ask
  // first when a pending transactional over it would be withdrawn.
  function withdraw(amendment: AmendmentDto, options: SettleOptions = {}) {
    return settle(amendment, "withdraw", options, isSessionOpen, (fresh) =>
      runOutcome(fresh, { action: "withdraw" }),
    );
  }

  function lapse(amendment: AmendmentDto, options: SettleOptions = {}) {
    return settle(amendment, "lapse", options, isSessionOpen, (fresh) =>
      runOutcome(fresh, { action: "lapse" }),
    );
  }

  /**
   * Withdraws a presented amendment that is not open to a decision yet, on
   * behalf of whoever presented it (POST .../withdraw: its authors or the
   * Mesa, until it is decided): a member's transactional the main authors
   * have not answered yet, or a late amendment the assembly has not agreed
   * to treat. Undone from the toast by reopening it.
   */
  async function withdrawSubmission(
    amendment: AmendmentDto,
  ): Promise<AmendmentDto | null> {
    const fresh = byId.value.get(amendment.id) ?? amendment;
    if (fresh.status !== "submitted") return null;
    try {
      const updated = await track(fresh.id, () =>
        api.send<AmendmentDto>(
          documentApi(`/amendments/${encodeURIComponent(fresh.id)}/withdraw`),
        ),
      );
      upsertAmendment(updated);
      toast.add({
        id: `session-outcome-${updated.id}`,
        title: t("session.toasts.withdrawn", {
          code: updated.code ?? label(updated.id),
        }),
        color: "success",
        icon: "i-lucide-check",
        actions: [
          {
            label: t("session.actions.undo"),
            color: "neutral",
            variant: "outline",
            onClick: () => {
              void reopen(updated);
            },
          },
        ],
      });
      return updated;
    } catch (error) {
      api.notifyError(error, "session.errors.outcome");
      onConflict(error);
      return null;
    }
  }

  /**
   * Reopens a decision. One taken in a vote between alternatives voids
   * that vote and reopens every amendment it decided, so it asks first and
   * says which (user's decision of 2026-11-20).
   */
  async function reopen(amendment: AmendmentDto) {
    const vote = amendment.outcomeVote;
    const several = [
      ...(vote?.options ?? []).flatMap((option) => option.amendmentIds),
      ...(vote?.blocAmendmentIds ?? []),
    ];
    if (vote && several.length > 0) {
      // Those the vote decided: a winner it kept undecided is not reopened.
      const others = several
        .filter(
          (id) =>
            id !== amendment.id &&
            byId.value.get(id)?.outcomeVote?.id === vote.id,
        )
        .map((id) => label(id));
      const confirmed = await confirm({
        title: t("session.alternatives.reopenTitle", {
          code: label(amendment.id),
        }),
        description:
          others.length > 0
            ? t("session.alternatives.reopenDescription", {
                codes: others.join(", "),
              })
            : t("session.alternatives.reopenDescriptionAlone"),
        confirmLabel:
          others.length > 0
            ? t("session.alternatives.reopenConfirm")
            : t("session.alternatives.reopenConfirmAlone"),
        confirmIcon: "i-lucide-rotate-ccw",
        confirmColor: "warning",
      });
      if (!confirmed) return null;
      return runOutcome(
        amendment,
        { action: "reopen", wholeVote: true },
        { offer: false },
      );
    }
    return runOutcome(amendment, { action: "reopen" }, { offer: false });
  }

  /**
   * Marks several undecided amendments as lapsed in one request (POST
   * .../amendments/lapse): one after another, every lapse made the whole
   * room refetch, and under load each one waited for the others.
   */
  async function lapseMany(ids: string[]): Promise<number> {
    if (!requireInSession()) return 0;
    const items: BulkLapseBody["items"] = [];
    let documentOf: string | null = null;
    for (const id of ids) {
      const amendment = byId.value.get(id);
      if (!amendment || !isSessionOpen(amendment)) continue;
      documentOf ??= amendment.documentId;
      if (amendment.documentId !== documentOf) continue;
      items.push({ id: amendment.id, updatedAt: amendment.updatedAt });
    }
    if (items.length === 0) return 0;
    let done: number;
    try {
      const response = await track("lapse-many", () =>
        api.send<BulkLapseDto>(documentApi("/amendments/lapse"), {
          body: { items } satisfies BulkLapseBody,
        }),
      );
      upsertAmendments(response.results.map((result) => result.amendment));
      done = response.results.length;
      // Lapsing closes the transactionals over it: the change's own live
      // event reads the rest of the list again.
      refreshUnlessLive(refreshAmendments);
      // Each one that could not lapse (decided or changed meanwhile), with
      // the reason the server gave, as the single lapse said it.
      if (response.failed.length > 0) {
        toast.add({
          title: t("session.errors.outcome"),
          description: response.failed
            .map((entry) => `${label(entry.id)}: ${entry.message}`)
            .join(" · "),
          color: "warning",
          icon: "i-lucide-triangle-alert",
        });
      }
    } catch (error) {
      api.notifyError(error, "session.errors.outcome");
      onConflict(error);
      // Part of it may have lapsed before the error.
      void refreshAmendments();
      return 0;
    }
    if (done > 0) {
      toast.add({
        title: t("session.toasts.lapsedMany", { count: done }, done),
        color: done === items.length ? "success" : "warning",
        icon: "i-lucide-check",
      });
    }
    return done;
  }

  /** Approves by assent every amendment of the plan, one after another. */
  async function bulkAssent(ids: string[]): Promise<number> {
    if (!requireInSession()) return 0;
    const items: BulkAssentBody["items"] = [];
    let documentOf: string | null = null;
    for (const id of ids) {
      const amendment = byId.value.get(id);
      if (!amendment || !isSessionOpen(amendment)) continue;
      // A transactional proposed over it since the plan was made: it
      // would be withdrawn without anyone saying so.
      if (sessionPendingTransactionalIds(amendment, byId.value).length > 0) {
        continue;
      }
      documentOf ??= amendment.documentId;
      if (amendment.documentId !== documentOf) continue;
      items.push({ id: amendment.id, updatedAt: amendment.updatedAt });
    }
    // The whole bloc in one request (user's decision of 2026-11-20): one
    // after another, every approval made the whole room refetch, and under
    // that load each one took seconds.
    let results: AmendmentOutcomeDto[] = [];
    if (items.length > 0) {
      try {
        const response = await track("bulk-assent", () =>
          api.send<BulkAssentDto>(documentApi("/amendments/assent"), {
            body: { items } satisfies BulkAssentBody,
          }),
        );
        results = response.results;
        upsertAmendments(results.map((result) => result.amendment));
      } catch (error) {
        // Stopped by an error, part of the bloc may be approved already:
        // the list is read again, and no count is given (it would say
        // none were approved).
        api.notifyError(error, "session.errors.outcome");
        onConflict(error);
        void refreshAmendments();
        return 0;
      }
    }
    const done = results.length;
    toast.add({
      title: t("session.toasts.assentMany", { count: done }, done),
      color: done === ids.length ? "success" : "warning",
      icon: "i-lucide-check-check",
    });

    // One lapse offer for the whole batch.
    const lapseIds = new Set<string>();
    for (const result of results) {
      const offer = sessionLapseOffer(
        result.amendment,
        amendments.value,
        relations.value,
        result.warnings,
      );
      offer.lapse.forEach((id) => lapseIds.add(id));
    }
    if (lapseIds.size > 0) {
      lapseDialog.targetId = null;
      lapseDialog.lapse = [...lapseIds];
      lapseDialog.open = true;
    }
    // What the approvals closed (transactionals over them): the bloc's own
    // live events read the list again.
    refreshUnlessLive(refreshAmendments);
    return done;
  }

  // Proponent position ------------------------------------------------------------

  /**
   * Records the answer the document's main presenter gives in the room
   * (accept, reject, transact). The comment already stored is kept: the
   * console only changes the position itself. The position it last saw
   * travels with it, so two people answering at once get a conflict instead
   * of overwriting each other. In a document that incorporates accepted
   * amendments, accepting approves it at once and changing the answer
   * reopens it: the toast says which.
   */
  async function setPosition(
    amendment: AmendmentDto,
    position: ProponentPosition,
  ): Promise<AmendmentDto | null> {
    // Accepting where accepted amendments are incorporated (always a
    // formal one, amendmentRule) approves it, which withdraws a pending
    // transactional over it: ask first.
    if (
      position === "accept" &&
      amendmentRule(
        amendment.kind,
        document.value?.acceptedAmendments ?? "vote",
      ) === "incorporate" &&
      !(await confirmSettling(
        byId.value.get(amendment.id) ?? amendment,
        "incorporate",
      ))
    ) {
      return null;
    }
    const fresh = byId.value.get(amendment.id) ?? amendment;
    const body: PositionBody = {
      position,
      comment: fresh.position?.comment ?? null,
      positionUpdatedAt: fresh.position?.updatedAt ?? null,
    };
    try {
      const updated = await track(amendment.id, () =>
        api.send<AmendmentDto>(
          documentApi(
            `/amendments/${encodeURIComponent(amendment.id)}/position`,
          ),
          { method: "PUT", body },
        ),
      );
      upsertAmendment(updated);
      const code = updated.code ?? label(updated.id);
      const incorporated =
        isSessionIncorporated(updated) && !isSessionIncorporated(fresh);
      const reopened =
        isSessionIncorporated(fresh) && updated.status === "submitted";
      toast.add({
        id: `session-position-${updated.id}`,
        title: incorporated
          ? t("session.toasts.incorporated", { code })
          : reopened
            ? t("session.toasts.unincorporated", { code })
            : t("amendment.position.saved"),
        color: "success",
        icon: "i-lucide-check",
      });
      // Incorporated like any approval: offer to lapse what it leaves
      // without object and flag what collides with it in the text.
      if (incorporated) offerLapses(updated, null);
      return updated;
    } catch (error) {
      api.notifyError(error, "amendment.position.saveFailed");
      onConflict(error);
      return null;
    }
  }

  // Admission ---------------------------------------------------------------------

  async function decideAdmission(body: AdmissionBody): Promise<boolean> {
    try {
      const result = await track("admission", () =>
        api.send<AmendmentAdmissionDto>(documentApi("/amendments/admission"), {
          body,
        }),
      );
      refreshUnlessLive(refreshAmendments);
      const count = result.amendmentIds.length;
      const reversed = result.admission !== body.decision;
      const opposite: SessionAdmissionDecision =
        result.admission === "admitted" ? "inadmissible" : "admitted";
      toast.add({
        title: reversed
          ? t("session.toasts.admissionVoteFailed")
          : result.admission === "admitted"
            ? t("session.toasts.admitted", { count }, count)
            : t("session.toasts.inadmissible", { count }, count),
        color: reversed ? "warning" : "success",
        icon: reversed ? "i-lucide-triangle-alert" : "i-lucide-check",
        // A mistaken decision is corrected with a new, recorded one.
        actions: [
          {
            label: t("session.actions.undo"),
            color: "neutral",
            variant: "outline",
            onClick: () => {
              openAdmission(result.amendmentIds, opposite);
            },
          },
        ],
      });
      // A decision vote is put on the projection by the server.
      return true;
    } catch (error) {
      if (sessionErrorData(error)?.tie === true) {
        toast.add({
          title: t("session.vote.tieTitle"),
          description: t("session.vote.tieRepeat"),
          color: "warning",
          icon: "i-lucide-scale",
        });
        return false;
      }
      api.notifyError(error, "session.errors.admission");
      onConflict(error);
      return false;
    }
  }

  // Validation by the Secretaría ----------------------------------------------------

  /** Stores the list a validation returned, if the console still shows it. */
  function storeAmendments(dto: DocumentAmendmentsDto, forDocument: string) {
    storeAmendmentList({ ...dto, documentId: forDocument });
  }

  /**
   * Validates presented amendments and makes them public at once (the Mesa
   * is in session: there is no reason to keep them private). On-time ones
   * are admitted with it; late ones move to the admission group. The page
   * focus follows the first of them to its new place in the queue, since
   * the button that was pressed leaves with its card.
   */
  async function validateAmendments(ids: string[]): Promise<boolean> {
    const forDocument = documentId.value;
    const targets = sessionValidationIds(amendments.value, ids);
    if (!forDocument || targets.length === 0) return false;
    const body: ValidateAmendmentsBody = {
      amendmentIds: targets,
      publish: true,
    };
    try {
      const dto = await track(
        targets.length === 1 ? targets[0]! : "validate",
        () =>
          api.send<DocumentAmendmentsDto>(documentApi("/amendments/validate"), {
            body,
          }),
      );
      storeAmendments(dto, forDocument);
      focusCard(targets[0]!);
      const count = targets.length;
      const late = dto.amendments.filter(
        (amendment) =>
          targets.includes(amendment.id) &&
          isSessionPendingAdmission(amendment),
      ).length;
      toast.add({
        id: `session-validated-${targets.join("-")}`,
        title: t("session.toasts.validated", { count }, count),
        description:
          late > 0
            ? t("session.toasts.validatedLate", { count: late }, late)
            : undefined,
        color: "success",
        icon: "i-lucide-badge-check",
      });
      return true;
    } catch (error) {
      api.notifyError(error, "session.errors.validate");
      onConflict(error);
      return false;
    }
  }

  /** Makes validated amendments visible to the whole assembly. */
  async function publishAmendments(ids: string[]): Promise<boolean> {
    const forDocument = documentId.value;
    const targets = ids.filter((id) => {
      const amendment = byId.value.get(id);
      return amendment ? isSessionPublishable(amendment) : false;
    });
    if (!forDocument || targets.length === 0) return false;
    const body: PublishAmendmentsBody = { amendmentIds: targets };
    try {
      const dto = await track(
        targets.length === 1 ? targets[0]! : "publish",
        () =>
          api.send<DocumentAmendmentsDto>(documentApi("/amendments/publish"), {
            body,
          }),
      );
      storeAmendments(dto, forDocument);
      const count = targets.length;
      toast.add({
        id: `session-published-${targets.join("-")}`,
        title: t("session.toasts.published", { count }, count),
        color: "success",
        icon: "i-lucide-eye",
      });
      return true;
    } catch (error) {
      api.notifyError(error, "session.errors.publish");
      onConflict(error);
      return false;
    }
  }

  // Relations ---------------------------------------------------------------------

  async function createRelation(body: RelationBody): Promise<boolean> {
    // A relation carries no document id: remember which document it is for.
    const forDocument = documentId.value;
    try {
      const relation = await track("relation", () =>
        api.send<RelationDto>(documentApi("/amendments/relations"), { body }),
      );
      const current = amendmentsDto.value;
      if (current && documentId.value === forDocument) {
        storeAmendmentList({
          ...current,
          relations: [...current.relations, relation],
        });
      }
      toast.add({
        title: t("session.toasts.relationCreated"),
        color: "success",
        icon: "i-lucide-link",
      });
      return true;
    } catch (error) {
      api.notifyError(error, "session.errors.relation");
      onConflict(error);
      return false;
    }
  }

  async function deleteRelation(id: string): Promise<boolean> {
    const forDocument = documentId.value;
    try {
      await track(`relation-${id}`, () =>
        api.send(
          documentApi(`/amendments/relations/${encodeURIComponent(id)}`),
          {
            method: "DELETE",
          },
        ),
      );
      const current = amendmentsDto.value;
      if (current && documentId.value === forDocument) {
        storeAmendmentList({
          ...current,
          relations: current.relations.filter((relation) => relation.id !== id),
        });
      }
      return true;
    } catch (error) {
      api.notifyError(error, "session.errors.relation");
      onConflict(error);
      return false;
    }
  }

  // Transactionals ----------------------------------------------------------------

  async function createTransactional(
    body: TransactionalBody,
  ): Promise<AmendmentDto | null> {
    try {
      const created = await track("transactional", () =>
        api.send<AmendmentDto>(documentApi("/amendments/transactional"), {
          body,
        }),
      );
      upsertAmendment(created);
      toast.add({
        title: t("session.toasts.transactionalCreated", {
          code: created.code ?? "",
        }),
        color: "success",
        icon: "i-lucide-git-merge",
      });
      return created;
    } catch (error) {
      api.notifyError(error, "session.errors.transactional");
      onConflict(error);
      return null;
    }
  }

  async function recordAcceptance(
    amendmentId: string,
    memberId: string,
    decision: "accepted" | "rejected",
  ): Promise<AmendmentDto | null> {
    try {
      const updated = await track(`acceptance-${amendmentId}-${memberId}`, () =>
        api.send<AmendmentDto>(
          documentApi(
            `/amendments/${encodeURIComponent(amendmentId)}/acceptance`,
          ),
          { body: { decision, memberId } },
        ),
      );
      upsertAmendment(updated);
      // The last acceptance replaces the sources (they become transacted)
      // and a rejection closes it: the rest of the list changes too, which
      // the change's own live event reads again.
      refreshUnlessLive(refreshAmendments);
      return updated;
    } catch (error) {
      api.notifyError(error, "session.errors.acceptance");
      onConflict(error);
      return null;
    }
  }

  // Final vote --------------------------------------------------------------------

  async function finalVote(
    body: FinalVoteBody,
  ): Promise<SessionFinalVoteResult> {
    if (!requireInSession()) {
      return {
        ok: false,
        conflicts: [],
        undecided: [],
        tie: false,
        pendingPassages: [],
      };
    }
    try {
      const updated = await track("final-vote", () =>
        api.send<DocumentDto>(documentApi("/final-vote"), { body }),
      );
      storeDocument(updated);
      refreshUnlessLive(refreshAgenda, refreshAmendments);
      toast.add({
        title:
          updated.finalVote?.result !== "approved"
            ? t("session.toasts.finalRejected")
            : updated.pendingConciliation > 0
              ? t("session.toasts.finalApprovedPending")
              : t("session.toasts.finalApproved"),
        color: updated.finalVote?.result === "approved" ? "success" : "warning",
        icon: "i-lucide-gavel",
      });
      return { ok: true, document: updated };
    } catch (error) {
      const data = sessionErrorData(error);
      const conflicts = Array.isArray(data?.conflicts)
        ? (data.conflicts as ConsolidationConflict[])
        : [];
      const undecidedIds = sessionErrorIds(error, "undecided");
      const tie = data?.tie === true;
      const pending = Array.isArray(data?.pendingPassages)
        ? (data.pendingPassages as Passage[])
        : [];
      if (
        conflicts.length === 0 &&
        undecidedIds.length === 0 &&
        !tie &&
        pending.length === 0
      ) {
        api.notifyError(error, "session.errors.finalVote");
      }
      if (pending.length > 0) void refreshAmendments();
      onConflict(error);
      return {
        ok: false,
        conflicts,
        undecided: undecidedIds,
        tie,
        pendingPassages: pending,
      };
    }
  }

  /**
   * Annuls a wrongly recorded final vote (DELETE .../final-vote). The vote
   * stays in the record; the document goes back to awaiting its final vote,
   * loses the consolidated text and its amendments can be decided again.
   */
  async function annulFinalVote(note: string | null): Promise<boolean> {
    const current = document.value;
    // `document` already hides the DTO carried over from the previous
    // document; checked again because its updatedAt must never go to
    // another document's URL.
    if (!current || current.id !== documentId.value) return false;
    const body: FinalVoteAnnulBody = {
      updatedAt: current.updatedAt,
      note: note?.trim() ? note.trim() : null,
    };
    try {
      const updated = await track("final-vote-annul", () =>
        api.send<DocumentDto>(documentApi("/final-vote"), {
          method: "DELETE",
          body,
        }),
      );
      storeDocument(updated);
      refreshUnlessLive(refreshAgenda, refreshAmendments);
      toast.add({
        title: t("session.toasts.finalAnnulled"),
        color: "success",
        icon: "i-lucide-rotate-ccw",
      });
      return true;
    } catch (error) {
      api.notifyError(error, "session.errors.annulFinalVote");
      onConflict(error);
      return false;
    }
  }

  // Agenda item votes ---------------------------------------------------------------

  /**
   * Records a vote on an agenda item itself (POST .../agenda/[item]/votes)
   * and asks the server to put it on screen. `itemId` is the item the dialog
   * opened on, never the item in debate now: the server projects it only
   * while that item is still in debate and stores it anyway (`projected`
   * false, and the toast says so). A tie the tie rule repeats goes back to
   * the dialog; an item that turned out to be voted through its documents,
   * or any other refusal, is a toast.
   */
  async function recordItemVote(
    itemId: string,
    input: { question: string; vote: VoteInput; election?: ElectionInput },
  ): Promise<SessionItemVoteResult> {
    if (!requireInSession()) return { ok: false, tie: false };
    const body: ItemVoteBody = {
      question: input.question.trim(),
      vote: sessionCleanVote(input.vote),
      ...(input.election
        ? {
            election: {
              ...input.election,
              candidates: input.election.candidates.map((name) => name.trim()),
            },
          }
        : {}),
      project: true,
    };
    try {
      const result = await track("item-vote", () =>
        api.send<ItemVoteResultDto>(
          `${assemblyUrl.value}/agenda/${encodeURIComponent(itemId)}/votes`,
          { body },
        ),
      );
      storeItemVote(result.vote);
      void refreshItemVotes();
      const approved = result.vote.result === "approved";
      toast.add({
        id: `session-item-vote-${result.vote.id}`,
        title: result.vote.election
          ? t("session.toasts.electionRecorded")
          : approved
            ? t("session.toasts.itemVoteApproved")
            : t("session.toasts.itemVoteRejected"),
        description: result.projected
          ? undefined
          : t("session.toasts.itemVoteNotProjected"),
        color: result.projected && approved ? "success" : "warning",
        icon: result.projected ? "i-lucide-gavel" : "i-lucide-monitor-off",
      });
      return { ok: true, vote: result.vote };
    } catch (error) {
      if (sessionErrorData(error)?.tie === true)
        return { ok: false, tie: true };
      if (errorReason(error) === "item_has_voted_documents") {
        toast.add({
          id: `session-item-vote-documents-${itemId}`,
          title: t("session.errors.itemVote"),
          description: t("session.errors.itemHasVotedDocuments"),
          color: "warning",
          icon: "i-lucide-file-check-2",
        });
        // The agenda the console holds did not show those documents voted.
        void refreshAgenda();
        return { ok: false, tie: false };
      }
      api.notifyError(error, "session.errors.itemVote");
      if (api.isConflict(error)) {
        void refreshAgenda();
        void refreshItemVotes();
      }
      return { ok: false, tie: false };
    }
  }

  /**
   * Voids a wrongly recorded item vote (DELETE .../votes/[vote]) once the
   * Mesa confirms it, naming the vote (`summary`, as the console words
   * it). It stays in the record and no longer gives the item's result; the
   * server takes it off the screen if it was there.
   */
  async function voidItemVote(
    vote: VoteDto,
    summary: string,
  ): Promise<boolean> {
    const confirmed = await confirm({
      title: t("session.itemVote.voidTitle"),
      description: t("session.itemVote.voidDescription", { vote: summary }),
      confirmLabel: t("session.itemVote.voidConfirm"),
      confirmIcon: "i-lucide-rotate-ccw",
      confirmColor: "error",
    });
    if (!confirmed) return false;
    // Its lock token as it is now: a live refresh may have arrived meanwhile.
    const fresh = itemVotes.value.find((other) => other.id === vote.id) ?? vote;
    if (fresh.voidedAt || busy.value[`vote-${fresh.id}`]) return false;
    const body: VoteVoidBody = { updatedAt: fresh.updatedAt };
    try {
      const updated = await track(`vote-${fresh.id}`, () =>
        api.send<VoteDto>(
          `${assemblyUrl.value}/votes/${encodeURIComponent(fresh.id)}`,
          { method: "DELETE", body },
        ),
      );
      storeItemVote(updated);
      void refreshItemVotes();
      toast.add({
        id: `session-item-vote-void-${updated.id}`,
        title: t("session.toasts.itemVoteVoided"),
        color: "success",
        icon: "i-lucide-rotate-ccw",
      });
      return true;
    } catch (error) {
      api.notifyError(error, "session.errors.itemVoteVoid");
      if (api.isConflict(error)) void refreshItemVotes();
      return false;
    }
  }

  /**
   * Marks an assent vote in force as unanimous (nobody objected when the
   * Mesa asked), or takes it back (PATCH .../votes/[vote]/unanimity): an
   * agenda item's vote, or the final vote of the document the console shows.
   * Its lock token is the one it holds now (a live refresh may have arrived
   * meanwhile), and the copies of it the console keeps (the item votes, the
   * document and the live state when it is on screen) take the new one.
   */
  async function setVoteUnanimity(
    vote: VoteDto,
    unanimous: boolean,
  ): Promise<boolean> {
    const isDocument = vote.subjectType === "document";
    const current = document.value;
    const fresh = isDocument
      ? current?.id === vote.subjectId && current.finalVote?.id === vote.id
        ? current.finalVote
        : null
      : (itemVotes.value.find((other) => other.id === vote.id) ?? vote);
    // A document vote the console no longer shows as in force is left alone.
    if (
      !fresh ||
      fresh.unanimous === unanimous ||
      busy.value[`vote-${fresh.id}`]
    ) {
      return false;
    }
    const refreshHolder = (): void => {
      if (isDocument) void refreshDocument();
      else void refreshItemVotes();
    };
    const body: VoteUnanimityBody = { unanimous, updatedAt: fresh.updatedAt };
    try {
      const updated = await track(`vote-${fresh.id}`, () =>
        api.send<VoteDto>(
          `${assemblyUrl.value}/votes/${encodeURIComponent(fresh.id)}/unanimity`,
          { method: "PATCH", body },
        ),
      );
      if (isDocument) {
        const shown = document.value;
        if (shown?.finalVote?.id === updated.id) {
          storeDocument({ ...shown, finalVote: updated });
        }
      } else {
        storeItemVote(updated);
      }
      // Its own live event reads the holder again (an item's vote has no
      // document; a final vote is the shown document's, affectsDocumentDto):
      // only without the stream is it read now.
      refreshUnlessLive(isDocument ? refreshDocument : refreshItemVotes);
      if (liveState.value?.vote?.id === updated.id) void refreshLive();
      toast.add({
        id: `session-vote-unanimity-${updated.id}`,
        title: updated.unanimous
          ? t("session.toasts.itemVoteUnanimous")
          : t("session.toasts.itemVoteNotUnanimous"),
        color: "success",
        icon: "i-lucide-check-check",
      });
      return true;
    } catch (error) {
      api.notifyError(error, "session.errors.itemVoteUnanimity");
      if (api.isConflict(error)) {
        refreshHolder();
        if (liveState.value?.vote?.id === fresh.id) void refreshLive();
      }
      return false;
    }
  }

  return {
    // data
    param,
    assembly,
    assemblyPending,
    settings,
    canModerate,
    inSession,
    requireInSession,
    agenda,
    agendaStatus,
    agendaError,
    agendaRows,
    liveState,
    /** What the console works on: the projection with control, else its own. */
    debate,
    inControl,
    control,
    awayFromScreen,
    followScreen,
    takeControl,
    liveStatus,
    documentId,
    document,
    documentStatus,
    documentError,
    amendmentsDto,
    amendmentsStatus,
    amendmentsError,
    amendments,
    relations,
    wordings,
    pendingPassages,
    impactOf,
    byId,
    base,
    incorporatesAccepted,
    label,
    stageOf,
    // derived
    hideDecided,
    queue,
    queueOrder,
    queueCounts,
    isVisible,
    undecided,
    finalVoteBlockers,
    preview,
    assentPlan,
    blocMode,
    blocSelected,
    blocOrder,
    toggleBloc,
    selectAcceptedBloc,
    clearBlocSelection,
    cancelBloc,
    blocOnScreen,
    proposalOnScreen,
    roomProposal,
    projectBloc,
    unprojectBloc,
    finalVoteReasons,
    focusedId,
    focused,
    moveFocus,
    // under debate
    showingLiveDocument,
    debatedAmendment,
    nextAmendment,
    nextAgendaTarget,
    itemGoneThrough,
    followLive,
    // live
    connected,
    polling,
    connection,
    refreshAll,
    refreshAmendments,
    refreshDocument,
    busy,
    // live state
    setLive,
    debateAgendaItem,
    debateDocument,
    debateAmendment,
    requestDebate,
    clearDebatedAmendment,
    clearDebatedDocument,
    clearDebate,
    debateNext,
    debateAgendaTarget,
    setMessage,
    setRecess,
    setSpeakingLimit,
    pushTally,
    setSpeakersVisible,
    // speaking turns
    speakers,
    headcounts,
    voteHeadcount,
    // agenda item votes
    itemVotes,
    refreshItemVotes,
    // how far the session has gone
    projectedDocumentIds,
    treatedItemIds,
    itemTreatment,
    itemMarkAction,
    setItemTreated,
    documentProgress,
    // dialogs
    voteDialog,
    relationDialog,
    admissionDialog,
    composer,
    finalVoteDialog,
    finalVoteAnnulDialog,
    assentDialog,
    roomAlternatives,
    blocVoteDialog,
    openBlocVote,
    voteBloc,
    alternativesDialog,
    openAlternatives,
    projectAlternatives,
    voteAlternatives,
    assentDialogPlan,
    openAssent,
    lapseDialog,
    wordingDialog,
    openWording,
    setWording,
    removeWording,
    speakerRenameDialog,
    headcountDialog,
    speakerAddDialog,
    pointerTools,
    documentScrolls,
    itemVoteDialog,
    anyDialogOpen,
    confirm,
    transactionalsOver,
    openVote,
    openRelation,
    openAdmission,
    openComposer,
    openSpeakerRename,
    openItemVote,
    // mutations
    approve,
    vote,
    withdraw,
    withdrawSubmission,
    lapse,
    reopen,
    lapseMany,
    bulkAssent,
    decideAdmission,
    validateAmendments,
    publishAmendments,
    createRelation,
    deleteRelation,
    createTransactional,
    recordAcceptance,
    setPosition,
    finalVote,
    annulFinalVote,
    recordItemVote,
    voidItemVote,
    setVoteUnanimity,
  };
}

export type SessionConsole = ReturnType<typeof useSessionConsole>;

const SESSION_CONSOLE_KEY: InjectionKey<SessionConsole> =
  Symbol("session-console");

/** Makes the console available to every session component below the page. */
export function provideSessionConsole(state: SessionConsole): void {
  provide(SESSION_CONSOLE_KEY, state);
}

/**
 * The console when the component is inside the session page, else null:
 * a form shared with other pages (the vote fields) adds what only the
 * console does, such as counting a secret vote live.
 */
export function useOptionalSessionConsole(): SessionConsole | null {
  return inject(SESSION_CONSOLE_KEY, null);
}

/** The console provided by the session page. */
export function useSessionConsoleContext(): SessionConsole {
  const state = inject(SESSION_CONSOLE_KEY, null);
  if (!state) {
    throw new Error("useSessionConsoleContext() needs provideSessionConsole()");
  }
  return state;
}
