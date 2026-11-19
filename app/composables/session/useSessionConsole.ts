import type { InjectionKey, MaybeRefOrGetter, Ref } from "vue";
import type {
  AdmissionBody,
  AgendaDto,
  AmendmentAdmissionDto,
  AmendmentDto,
  AmendmentOutcomeDto,
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
  type ProponentPosition,
} from "~~/shared/constants/domain";
import {
  isSessionInProgress,
  liveStateClearsOnly,
} from "~~/shared/utils/sessionGate";
import { useApi } from "../api/useApi";
import { CURRENT_ASSEMBLY_KEY } from "../assembly/useCurrentAssembly";
import {
  keepLastGoodData,
  onlyForKey,
  useStaleDataNotice,
} from "../fetch/lastGoodData";
import { useAssemblyLive } from "../live/useAssemblyLive";
import SessionConfirmDialog from "~/components/session/ConfirmDialog.vue";
import {
  buildSessionAgendaRows,
  buildSessionQueue,
  isSessionAwaitingValidation,
  isSessionIncorporated,
  isSessionOpen,
  isSessionPendingAdmission,
  isSessionPublishable,
  isSessionTransactable,
  sessionAmendmentStage,
  sessionAssentPlan,
  sessionCleanVote,
  sessionConnectionState,
  sessionApprovalImpact,
  sessionConsolidatedPreview,
  sessionErrorData,
  sessionErrorIds,
  sessionFinalVoteBlockers,
  sessionFinalVoteReasons,
  sessionLapseOffer,
  sessionNextAgendaTarget,
  sessionNextAmendmentId,
  sessionPendingTransactionalIds,
  sessionQueueCounts,
  sessionQueueOrder,
  sessionSettleConfirm,
  sessionValidationIds,
  type SessionAdmissionDecision,
  type SessionAgendaTarget,
  type SessionAmendmentStage,
  type SessionSettleAction,
} from "./sessionModel";
import { agendaWithTitles } from "~/utils/agendaTitles";
import { useHeadcounts } from "./useSessionHeadcounts";
import { useSessionSpeakers } from "./useSessionSpeakers";
import { useSessionTransactionalsOver } from "./useSessionTransactionalsOver";
import { useProjectionControl } from "./useProjectionControl";

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

  const liveFetch = useAsyncData(
    () => `session-live-${param.value}`,
    () => api.get<LiveStateDto>(`${assemblyUrl.value}/live-state`),
  );
  const { status: liveStatus, refresh: refreshLive } = liveFetch;
  const { data: liveState, stale: liveStale } = keepLastGoodData(liveFetch, {
    resetOn: param,
  });

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
    return {
      ...live,
      agendaItemId: own.agendaItemId,
      documentId: own.documentId,
      amendmentId: own.amendmentId,
      vote: onScreen ? live.vote : null,
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
  /** Why the final vote cannot be recorded yet (empty when it can). */
  const finalVoteReasons = computed(() =>
    sessionFinalVoteReasons({
      document: document.value ?? null,
      amendmentsLoaded: Boolean(amendmentsDto.value),
      blockers: finalVoteBlockers.value,
      pendingWordings: pendingPassages.value.length,
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
  /** The agenda item after the one in debate, with its only document. */
  const nextAgendaTarget = computed(() =>
    sessionNextAgendaTarget(
      agendaRows.value,
      debate.value?.agendaItemId ?? null,
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

  // How far the session has gone: the documents projected and the items
  // treated (the Mesa's mark in the control sheet, also set as the debate
  // moves on). The Mesa only, as itself; a failed read keeps the last good
  // marks, and with none the console marks nothing.
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
  const treatedItemIds = computed(
    () => new Set(progressDto.value?.treatedItemIds ?? []),
  );

  function refreshProgress(): Promise<void> {
    return progressFetch.refresh();
  }

  /** Each document's automatic sub-item: its mark in the sheet is the document's. */
  const autoItemOfDocument = computed(
    () =>
      new Map(
        (agenda.value?.items ?? [])
          .filter((item) => item.generatedForDocumentId)
          .map((item) => [item.generatedForDocumentId!, item.id]),
      ),
  );

  /**
   * Where a document stands in the session: `treated` once its automatic
   * sub-item is marked treated, `projected` once the Mesa put it on screen,
   * else null.
   */
  function documentProgress(
    documentId: string,
  ): "treated" | "projected" | null {
    const autoItem = autoItemOfDocument.value.get(documentId);
    if (autoItem && treatedItemIds.value.has(autoItem)) return "treated";
    return projectedDocumentIds.value.has(documentId) ? "projected" : null;
  }

  /** Puts a vote a mutation returned in the list, replacing its old copy. */
  function storeItemVote(vote: VoteDto): void {
    const current = itemVotesDto.value?.votes ?? [];
    const index = current.findIndex((other) => other.id === vote.id);
    const next = [...current];
    if (index === -1) next.push(vote);
    else next[index] = vote;
    itemVotesDto.value = { votes: next };
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
    let live = false;
    let assemblyChanged = false;
    let agendaChanged = false;
    let documentChanged = false;
    let amendmentsChanged = false;
    let itemVotesChanged = false;
    let progressChanged = false;
    const projectedVoteId = liveState.value?.vote?.id ?? null;
    // Control of the projection moved: this console asks who holds it now.
    if (events.some((event) => event.entityType === "projection")) {
      void control.refresh();
    }
    for (const event of events) {
      if (event.entityType === "live") live = true;
      // A document goes on screen or the debate moves on (live), or the
      // Mesa ticks an item in the sheet (control_sheet).
      if (event.entityType === "live" || event.entityType === "control_sheet") {
        progressChanged = true;
      }
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
        event.entityType === "document"
      ) {
        agendaChanged = true;
      }
      const touchesCurrent =
        current !== null &&
        (event.documentId === current ||
          (event.entityType === "document" && event.entityId === current));
      if (touchesCurrent) {
        amendmentsChanged = true;
        if (event.entityType === "document" || event.entityType === "vote") {
          documentChanged = true;
        }
      }
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
  if (hub) {
    hub.onLive(onLive);
    ({ connected, polling } = hub.live);
  } else {
    ({ connected, polling } = useAssemblyLive(
      () => assembly.value?.id,
      onLive,
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

  // Local updates ---------------------------------------------------------------

  /** Puts a fresh amendment in the local list, so its updatedAt is current. */
  function upsertAmendment(amendment: AmendmentDto): void {
    const current = amendmentsDto.value;
    if (!current || amendment.documentId !== documentId.value) return;
    const index = current.amendments.findIndex(
      (other) => other.id === amendment.id,
    );
    const next = [...current.amendments];
    if (index === -1) next.push(amendment);
    else next[index] = amendment;
    amendmentsDto.value = { ...current, amendments: next };
  }

  /**
   * Stores a document a mutation returned, only if the console still shows
   * it: another Mesa member may have moved the debate (and the console with
   * it) while the request was in flight, and the fetch key now points at
   * the new document's entry.
   */
  function storeDocument(updated: DocumentDto): void {
    if (updated.id === documentId.value) document.value = updated;
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
      liveState.value = await track(options.key ?? "live", () =>
        api.send<LiveStateDto>(`${assemblyUrl.value}/live-state`, {
          method: "PUT",
          body,
        }),
      );
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
    if (inControl.value) return setLive(body);
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
  function sendTally(): void {
    tallyTimer = undefined;
    void api
      .send(`${assemblyUrl.value}/live-tally`, {
        method: "POST",
        body: { tally: pendingTally },
      })
      .catch(() => undefined);
  }
  function pushTally(tally: LiveTally | null): void {
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
  const assentDialog = reactive({ open: false });
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
    admissionDialog.ids = ids;
    admissionDialog.decision = decision;
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
      // Approving a transactional changes its sources; reopening may give them back.
      if (
        result.amendment.kind === "transactional" ||
        action.action === "reopen"
      ) {
        void refreshAmendments();
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
    wordingDialog.editing = editing || passage.status !== "automatic";
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

  function reopen(amendment: AmendmentDto) {
    return runOutcome(amendment, { action: "reopen" }, { offer: false });
  }

  /** Marks several undecided amendments as lapsed, one after another. */
  async function lapseMany(ids: string[]): Promise<number> {
    let done = 0;
    await track("lapse-many", async () => {
      for (const id of ids) {
        const amendment = byId.value.get(id);
        if (!amendment || !isSessionOpen(amendment)) continue;
        const result = await runOutcome(
          amendment,
          { action: "lapse" },
          { offer: false, toast: false },
        );
        if (result) done += 1;
      }
    });
    if (done > 0) {
      toast.add({
        title: t("session.toasts.lapsedMany", { count: done }, done),
        color: "success",
        icon: "i-lucide-check",
      });
    }
    return done;
  }

  /** Approves by assent every amendment of the plan, one after another. */
  async function bulkAssent(ids: string[]): Promise<number> {
    const results: AmendmentOutcomeDto[] = [];
    await track("bulk-assent", async () => {
      for (const id of ids) {
        const amendment = byId.value.get(id);
        if (!amendment || !isSessionOpen(amendment)) continue;
        // A transactional proposed over it since the plan was made: it
        // would be withdrawn without anyone saying so.
        if (sessionPendingTransactionalIds(amendment, byId.value).length > 0) {
          continue;
        }
        const result = await runOutcome(
          amendment,
          { action: "approve", method: "assent" },
          { offer: false, toast: false },
        );
        if (result) results.push(result);
      }
    });
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
    void refreshAmendments();
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
    // Accepting where accepted amendments are incorporated approves it,
    // which withdraws a pending transactional over it: ask first.
    if (
      position === "accept" &&
      incorporatesAccepted.value &&
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
      void refreshAmendments();
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
    if (documentId.value === forDocument) {
      amendmentsDto.value = { ...dto, documentId: forDocument };
    }
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
        amendmentsDto.value = {
          ...current,
          relations: [...current.relations, relation],
        };
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
        amendmentsDto.value = {
          ...current,
          relations: current.relations.filter((relation) => relation.id !== id),
        };
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
      // and a rejection closes it: the rest of the list changes too.
      void refreshAmendments();
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
      void refreshAgenda();
      void refreshAmendments();
      toast.add({
        title:
          updated.finalVote?.result === "approved"
            ? t("session.toasts.finalApproved")
            : t("session.toasts.finalRejected"),
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
      void refreshAgenda();
      void refreshAmendments();
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
    input: { question: string; vote: VoteInput },
  ): Promise<SessionItemVoteResult> {
    if (!requireInSession()) return { ok: false, tie: false };
    const body: ItemVoteBody = {
      question: input.question.trim(),
      vote: sessionCleanVote(input.vote),
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
        title: approved
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
      refreshHolder();
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
    finalVoteReasons,
    focusedId,
    focused,
    moveFocus,
    // under debate
    showingLiveDocument,
    debatedAmendment,
    nextAmendment,
    nextAgendaTarget,
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
    documentProgress,
    // dialogs
    voteDialog,
    relationDialog,
    admissionDialog,
    composer,
    finalVoteDialog,
    finalVoteAnnulDialog,
    assentDialog,
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
