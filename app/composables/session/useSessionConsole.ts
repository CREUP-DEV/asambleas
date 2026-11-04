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
  LiveEventDto,
  LiveStateBody,
  LiveStateDto,
  OutcomeAction,
  PositionBody,
  RelationBody,
  RelationDto,
  TransactionalBody,
  VoteInput,
} from "~~/shared/types/api";
import type { ConsolidationConflict } from "~~/shared/types/content";
import {
  DEFAULT_ASSEMBLY_SETTINGS,
  type AssemblySettings,
  type ProponentPosition,
} from "~~/shared/constants/domain";
import { useApi } from "../api/useApi";
import { CURRENT_ASSEMBLY_KEY } from "../assembly/useCurrentAssembly";
import {
  keepLastGoodData,
  onlyForKey,
  useStaleDataNotice,
} from "../fetch/lastGoodData";
import { useAssemblyLive } from "../live/useAssemblyLive";
import {
  buildSessionAgendaRows,
  buildSessionQueue,
  isSessionOpen,
  sessionAssentPlan,
  sessionConsolidatedPreview,
  sessionErrorData,
  sessionErrorIds,
  sessionLapseOffer,
  sessionQueueOrder,
  type SessionAdmissionDecision,
} from "./sessionModel";

export type SessionFinalVoteResult =
  | { ok: true; document: DocumentDto }
  | {
      ok: false;
      conflicts: ConsolidationConflict[];
      undecided: string[];
      tie: boolean;
      /** An approved totality return: the text goes back, no final vote. */
      totalityReturn: string | null;
    };

/** A document's amendments, tagged with the document they were fetched for. */
export type SessionAmendmentsDto = DocumentAmendmentsDto & {
  documentId: string;
};

export interface SessionLapseDialog {
  open: boolean;
  /** The amendment just decided. */
  targetId: string | null;
  lapse: string[];
  collisions: string[];
}

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
  const { data: agenda, stale: agendaStale } = keepLastGoodData(agendaFetch, {
    resetOn: param,
  });

  const liveFetch = useAsyncData(
    () => `session-live-${param.value}`,
    () => api.get<LiveStateDto>(`${assemblyUrl.value}/live-state`),
  );
  const { status: liveStatus, refresh: refreshLive } = liveFetch;
  const { data: liveState, stale: liveStale } = keepLastGoodData(liveFetch, {
    resetOn: param,
  });

  const settings = computed<AssemblySettings>(() => ({
    ...DEFAULT_ASSEMBLY_SETTINGS,
    ...(assembly.value?.settings ?? {}),
  }));
  const canModerate = computed(() => assembly.value?.can.moderate ?? false);

  const agendaRows = computed(() =>
    buildSessionAgendaRows(
      agenda.value?.items ?? [],
      agenda.value?.documents ?? [],
    ),
  );
  const agendaDocuments = computed(() =>
    agendaRows.value.flatMap((row) => row.documents),
  );

  /** The document the console shows. It follows the one in debate. */
  const documentId = ref<string | null>(null);

  watch(
    () => liveState.value?.documentId ?? null,
    (id) => {
      if (id) documentId.value = id;
    },
    { immediate: true },
  );

  watch(
    agendaDocuments,
    (documents) => {
      if (documentId.value || documents.length === 0) return;
      const first =
        documents.find(
          (document) => document.status === "published" && document.amendable,
        ) ?? documents.find((document) => document.status === "published");
      documentId.value = first?.id ?? null;
    },
    { immediate: true },
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
  const byId = computed(
    () =>
      new Map(amendments.value.map((amendment) => [amendment.id, amendment])),
  );
  const base = computed(() => document.value?.baseVersion?.blocks ?? []);

  /** Short label of an amendment: its code, or "#n" before it has one. */
  function label(id: string): string {
    const amendment = byId.value.get(id);
    if (!amendment) return "?";
    return amendment.code ?? (amendment.number ? `#${amendment.number}` : "?");
  }

  // Queue ---------------------------------------------------------------------

  const hideDecided = ref(false);
  const queue = computed(() => buildSessionQueue(amendments.value));
  const isVisible = (amendment: AmendmentDto) =>
    !hideDecided.value || amendment.status === "submitted";
  const queueOrder = computed(() => sessionQueueOrder(queue.value, isVisible));
  const undecided = computed(() =>
    amendments.value.filter((amendment) => amendment.status === "submitted"),
  );
  const preview = computed(() =>
    sessionConsolidatedPreview(base.value, amendments.value),
  );
  const assentPlan = computed(() => sessionAssentPlan(amendments.value));

  /** The amendment the keyboard shortcuts act on. */
  const focusedId = ref<string | null>(null);
  const focused = computed(() =>
    focusedId.value ? (byId.value.get(focusedId.value) ?? null) : null,
  );

  watch(documentId, () => {
    focusedId.value = null;
  });

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

  // Live updates --------------------------------------------------------------

  function refreshAll(): Promise<unknown> {
    return Promise.all([
      refreshAssembly(),
      refreshAgenda(),
      refreshLive(),
      refreshDocument(),
      refreshAmendments(),
    ]);
  }

  function onLive(events: LiveEventDto[]): void {
    if (events.some((event) => event.type === "poll")) {
      // The hub refreshes the assembly itself on poll events.
      void (hub
        ? Promise.all([
            refreshAgenda(),
            refreshLive(),
            refreshDocument(),
            refreshAmendments(),
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
    for (const event of events) {
      if (event.entityType === "live") live = true;
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

  /** Mutations in flight, by amendment id or action name. */
  const busy = ref<Record<string, boolean>>({});

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

  function onConflict(error: unknown): void {
    if (api.isConflict(error)) {
      void refreshAmendments();
      void refreshDocument();
    }
  }

  // Live state ------------------------------------------------------------------

  async function setLive(
    body: LiveStateBody,
    options: { silent?: boolean } = {},
  ): Promise<boolean> {
    try {
      liveState.value = await track("live", () =>
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

  function debateAgendaItem(itemId: string): Promise<boolean> {
    return setLive({
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
    const ok = await setLive({
      agendaItemId: target.agendaItemId,
      documentId: target.id,
      amendmentId: null,
      voteId: null,
    });
    if (ok) documentId.value = target.id;
    return ok;
  }

  function debateAmendment(amendment: AmendmentDto): Promise<boolean> {
    return setLive({
      documentId: amendment.documentId,
      amendmentId: amendment.id,
      voteId: null,
    });
  }

  function clearDebatedAmendment(): Promise<boolean> {
    return setLive({ amendmentId: null, voteId: null });
  }

  function setMessage(message: string | null): Promise<boolean> {
    return setLive({ message: message?.trim() ? message.trim() : null });
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
    collisions: [],
  });

  // The document follows the live state, which another Mesa member can move.
  // A document-level dialog left open would then record or annul the final
  // vote of a document the Mesa did not open it for.
  watch(documentId, () => {
    finalVoteDialog.open = false;
    finalVoteAnnulDialog.open = false;
  });

  const anyDialogOpen = computed(
    () =>
      voteDialog.open ||
      relationDialog.open ||
      admissionDialog.open ||
      composer.open ||
      finalVoteDialog.open ||
      finalVoteAnnulDialog.open ||
      assentDialog.open ||
      lapseDialog.open,
  );

  function openVote(amendment: AmendmentDto): void {
    voteDialog.amendmentId = amendment.id;
    voteDialog.open = true;
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

  function openComposer(sourceIds: string[]): void {
    composer.sourceIds = sourceIds.filter((id) => {
      const amendment = byId.value.get(id);
      return amendment ? isSessionOpen(amendment) : false;
    });
    composer.open = true;
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
    if (offer.lapse.length === 0 && offer.collisions.length === 0) return;
    lapseDialog.targetId = target.id;
    lapseDialog.lapse = offer.lapse;
    lapseDialog.collisions = offer.collisions;
    lapseDialog.open = true;
  }

  function approve(
    amendment: AmendmentDto,
    method: "assent" | "proponent" | "formal",
  ) {
    return runOutcome(amendment, { action: "approve", method });
  }

  function vote(amendment: AmendmentDto, input: VoteInput) {
    return runOutcome(amendment, { action: "vote", vote: input });
  }

  function withdraw(amendment: AmendmentDto) {
    return runOutcome(amendment, { action: "withdraw" });
  }

  function lapse(amendment: AmendmentDto) {
    return runOutcome(amendment, { action: "lapse" });
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
        if (!amendment || amendment.status !== "submitted") continue;
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
    const collisionIds = new Set<string>();
    for (const result of results) {
      const offer = sessionLapseOffer(
        result.amendment,
        amendments.value,
        relations.value,
        result.warnings,
      );
      offer.lapse.forEach((id) => lapseIds.add(id));
      offer.collisions.forEach((id) => collisionIds.add(id));
    }
    if (lapseIds.size > 0 || collisionIds.size > 0) {
      lapseDialog.targetId = null;
      lapseDialog.lapse = [...lapseIds];
      lapseDialog.collisions = [...collisionIds];
      lapseDialog.open = true;
    }
    void refreshAmendments();
    return done;
  }

  // Proponent position ------------------------------------------------------------

  /**
   * Records the position the proponent states in the room (accept, reject,
   * transact). The comment already stored is kept: the console only changes
   * the position itself.
   */
  async function setPosition(
    amendment: AmendmentDto,
    position: ProponentPosition,
  ): Promise<AmendmentDto | null> {
    const fresh = byId.value.get(amendment.id) ?? amendment;
    const body: PositionBody = {
      position,
      comment: fresh.position?.comment ?? null,
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
      toast.add({
        id: `session-position-${updated.id}`,
        title: t("amendment.position.saved"),
        color: "success",
        icon: "i-lucide-check",
      });
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
      const totalityReturn =
        typeof data?.totalityReturn === "string" ? data.totalityReturn : null;
      if (
        conflicts.length === 0 &&
        undecidedIds.length === 0 &&
        !tie &&
        !totalityReturn
      ) {
        api.notifyError(error, "session.errors.finalVote");
      }
      onConflict(error);
      return {
        ok: false,
        conflicts,
        undecided: undecidedIds,
        tie,
        totalityReturn,
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

  return {
    // data
    param,
    assembly,
    assemblyPending,
    settings,
    canModerate,
    agenda,
    agendaStatus,
    agendaError,
    agendaRows,
    liveState,
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
    byId,
    base,
    label,
    // derived
    hideDecided,
    queue,
    queueOrder,
    isVisible,
    undecided,
    preview,
    assentPlan,
    focusedId,
    focused,
    moveFocus,
    // live
    connected,
    polling,
    refreshAll,
    refreshAmendments,
    refreshDocument,
    busy,
    // live state
    setLive,
    debateAgendaItem,
    debateDocument,
    debateAmendment,
    clearDebatedAmendment,
    setMessage,
    // dialogs
    voteDialog,
    relationDialog,
    admissionDialog,
    composer,
    finalVoteDialog,
    finalVoteAnnulDialog,
    assentDialog,
    lapseDialog,
    anyDialogOpen,
    openVote,
    openRelation,
    openAdmission,
    openComposer,
    // mutations
    approve,
    vote,
    withdraw,
    lapse,
    reopen,
    lapseMany,
    bulkAssent,
    decideAdmission,
    createRelation,
    deleteRelation,
    createTransactional,
    recordAcceptance,
    setPosition,
    finalVote,
    annulFinalVote,
  };
}

export type SessionConsole = ReturnType<typeof useSessionConsole>;

const SESSION_CONSOLE_KEY: InjectionKey<SessionConsole> =
  Symbol("session-console");

/** Makes the console available to every session component below the page. */
export function provideSessionConsole(state: SessionConsole): void {
  provide(SESSION_CONSOLE_KEY, state);
}

/** The console provided by the session page. */
export function useSessionConsoleContext(): SessionConsole {
  const state = inject(SESSION_CONSOLE_KEY, null);
  if (!state) {
    throw new Error("useSessionConsoleContext() needs provideSessionConsole()");
  }
  return state;
}
