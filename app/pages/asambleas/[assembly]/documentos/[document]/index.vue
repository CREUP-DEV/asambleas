<script setup lang="ts">
import type { OutlineEntry } from "~/components/content/ContentView.vue";
import type { AmendmentDto } from "~~/shared/types/api";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { touchedBlockIds, validateOps } from "~~/shared/utils/content/ops";
import { blockLabels } from "~~/shared/utils/content/render";
import {
  proponentReviewBacklog,
  transactionalSourceCandidates,
  transactionalSourceEligible,
} from "~/composables/amendment/transactional";
import {
  amendmentReviewQueue,
  amendmentsAwaitingActor,
  consolidationInputs,
  contiguousBlockRange,
  extendBlockSelection,
  isAmendmentAuthor,
  isAmendmentPrivate,
  type AmendmentComposerMode,
  type AmendmentReviewFilter,
  type BlockSelection,
} from "~/composables/amendment/workspace";
import {
  documentAudience,
  documentProgress,
} from "~/composables/document/documentProgress";

/**
 * Document workspace (inside the assembly hub). Its one primary action, for
 * those who can amend, is "Presentar una enmienda": pick the paragraph in
 * the text, then choose in plain words what to do with it ("Cambiar este
 * texto", "Añadir un párrafo después", "Quitar este párrafo"); changing a
 * word everywhere and totality amendments sit in a "Más" menu. The
 * composer then opens in place of the list. Once a paragraph is picked, the
 * selection bar's "Cambiar este texto" is the one primary button.
 *
 * The document's main presenter (and the Mesa, which can answer for it) get
 * "Revisar enmiendas", with how many amendments wait for the main
 * presenter's answer (published, admitted if late, and for a transactional,
 * accepted by the main authors; none once the document was voted), which
 * leads to the guided review
 * (.../revisar). For the main presenter with something pending it is the
 * primary button instead of "Presentar una enmienda". Its co-presenters,
 * who do not answer, find "Ver las respuestas" in the "Más" menu: the same
 * page, read-only, with what the main presenter (or the Mesa for it)
 * answered.
 *
 * "Proponer una transaccional" (any member who can amend, the document's
 * presenter, and the Mesa) is a secondary action: in the header's "Más"
 * menu, on a group of amendments on the same passage, and in an
 * amendment's detail. Its composer opens in
 * place of the list like the amendment composer, with the passage it
 * rewrites marked in the text.
 *
 * The text is on the left, with four views in a compact "Ver" menu
 * (original with gutter markers, one amendment over the full text, live
 * consolidation with provenance, side by side: on wide screens it takes the
 * whole workspace until an amendment or a composer is opened); the
 * amendments are on the right, grouped by the passage they act on, with
 * "Mis enmiendas" showing where the actor's own stand with the Secretaría
 * (its badge counts what waits for them). Corrections the Secretaría asked
 * for get a notice above
 * the workspace; the Secretaría gets a quiet line with what it still has to
 * review or publish, and what it sent back for correction (those drafts are
 * listed only under that filter). Secondary links live in the header's
 * "Más" menu. On narrow screens the two panels stack behind a toggle and
 * the amendment detail opens in a slideover.
 *
 * `?enmienda=<id>` opens that amendment (links from the home page), and
 * `?transaccional=<id>,<id>` opens the transactional composer on those
 * amendments (from the presenter's review, "Transaccionar"). The open
 * amendment is kept in the address, so its link can be shared.
 *
 * A PDF document shows its file, or says it is still to be uploaded. An
 * unpublished one says amendments open once the Secretaría publishes it,
 * unless it takes none or is back with its presenters for a correction (the
 * header then says who acts next).
 */

interface TextViewHandle {
  getSelectedBlockIds: () => string[];
  scrollToBlock: (
    blockId: string,
    options?: { align?: "center" | "start" },
  ) => void;
  currentHeading: () => string | null;
  outline: OutlineEntry[];
}

type TextMode = "original" | "amended" | "consolidated" | "compare";
type Pane = "text" | "amendments";
type ListTab = "all" | "mine";

interface ComposerState {
  key: number;
  mode: AmendmentComposerMode;
  selection: string[];
  appendParagraph: boolean;
  draftId: string | null;
}

interface TransactionalState {
  key: number;
  /** Amendments it starts from (none: the author picks them). */
  sourceIds: string[];
}

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const { member } = useMe();
const workspace = useDocumentWorkspace();
const {
  assembly,
  document,
  base,
  amendments: list,
  amendmentsUrl,
  documentPath,
  pending,
  errorStatusCode,
  refreshAll,
} = workspace;

useHead({
  title: () => document.value?.title ?? t("workspace.title"),
});

const isDesktop = useMediaQuery("(min-width: 1024px)");
const textView = useTemplateRef<TextViewHandle>("textView");
const draftView = useTemplateRef<TextViewHandle>("draftView");

/** The headings of the text on show, for its index (two or more). */
const textOutline = computed(() => textView.value?.outline ?? []);
const draftOutline = computed(() => draftView.value?.outline ?? []);
const workspaceBox = useTemplateRef<HTMLElement>("workspaceBox");
const selectionBar = useTemplateRef<HTMLElement>("selectionBar");

// Document state ----------------------------------------------------------------

const isStructured = computed(() => document.value?.format === "structured");
const isPublished = computed(
  () => Boolean(document.value?.baseVersion) && base.value.length > 0,
);
const canAmend = computed(
  () =>
    Boolean(document.value?.can.amend) &&
    isPublished.value &&
    !document.value?.finalVote,
);
const finalText = computed(
  () => document.value?.consolidatedVersion?.blocks ?? null,
);
/** The working draft is edited on .../editar until the text is frozen. */
const canEditDraft = computed(
  () =>
    Boolean(document.value?.can.edit) && document.value?.status !== "published",
);
/**
 * Secretaría manages the document record there at every stage (metadata,
 * amendment window, status), also once the text is frozen: published,
 * withdrawn or postponed after publication.
 */
/** The Secretaría looks at a presented document to validate it. */
const reviewing = computed(
  () =>
    Boolean(document.value?.can.manage) &&
    document.value?.status === "submitted",
);
const canEditRecord = computed(
  () => Boolean(document.value?.can.manage) && !canEditDraft.value,
);
/**
 * The header tells the presenter of a draft what comes next ("Tienes que
 * corregirlo: …") with its own button ("Corregir y volver a enviar"); the
 * page then offers no second "Editar borrador". The Secretaría, which has
 * no such step, keeps that button.
 */
const headerHasNextStep = computed(() => {
  const doc = document.value;
  if (!doc || !canEditDraft.value) return false;
  const audience = documentAudience(doc, {
    memberId: member.value?.id,
    manager: doc.can.manage,
  });
  return documentProgress(doc, audience).action !== null;
});
/** Assembly decisions, to show how late amendments were admitted. */
const decisionsUrl = computed(() =>
  assembly.value
    ? `/api/assemblies/${encodeURIComponent(assembly.value.id)}/decisions`
    : undefined,
);
const labels = computed(() => blockLabels(base.value));

/** The document's main presenter: it answers the amendments to it. */
const proponentMemberId = computed(() => document.value?.proponent?.id ?? null);

/**
 * Any member who can amend, the document's main presenter and the Mesa may
 * propose a transactional over published, undecided amendments while the
 * text is open. The server also lets the authors of the chosen amendments
 * do it; it checks the rest.
 */
const canTransact = computed(() => {
  const doc = document.value;
  if (
    !doc ||
    !isStructured.value ||
    !isPublished.value ||
    doc.finalVote ||
    assembly.value?.status === "closed"
  ) {
    return false;
  }
  if (doc.can.moderate) return true;
  const memberId = member.value?.id ?? null;
  if (!memberId) return false;
  return doc.can.amend || proponentMemberId.value === memberId;
});
const transactionalCandidates = computed(() =>
  canTransact.value ? transactionalSourceCandidates(list.listed.value) : [],
);

/** The viewer's member is the document's main presenter. */
const isDocumentPresenter = computed(
  () =>
    proponentMemberId.value !== null &&
    proponentMemberId.value === member.value?.id,
);
/**
 * What waits for the main presenter's answer (document.proponent) in the
 * review mode, by the document's rule: the review mode's pending steps.
 * Answers belong to the amendment, so the main presenter and the Mesa,
 * which answers for it, count the same ones.
 */
const reviewBacklog = computed(() =>
  proponentReviewBacklog(
    list.listed.value,
    document.value?.acceptedAmendments ?? "vote",
    { finalVoted: Boolean(document.value?.finalVote) },
  ),
);
/** Status of any amendment, so a transactional tells whether it replaced its sources. */
function amendmentStatusOf(id: string) {
  return list.byId.value.get(id)?.status;
}
const showReviewEntry = computed(
  () =>
    Boolean(document.value?.can.position) &&
    isStructured.value &&
    isPublished.value &&
    list.listed.value.length > 0,
);
/**
 * A co-presenter reads the main presenter's answers on the review page,
 * read-only: the member presents the document jointly and neither answers
 * nor moderates (the review page's own rule, `readsAnswers`).
 */
const showAnswersEntry = computed(() => {
  const doc = document.value;
  const memberId = member.value?.id ?? null;
  if (
    !doc ||
    memberId === null ||
    !isStructured.value ||
    !isPublished.value ||
    list.listed.value.length === 0 ||
    doc.can.position ||
    doc.can.moderate ||
    isDocumentPresenter.value
  ) {
    return false;
  }
  return doc.coProponents.some((coProponent) => coProponent.id === memberId);
});
/**
 * "Revisar enmiendas" leads for the presenter with something pending. A
 * paragraph picked (the selection bar leads) or a composer open (its send
 * button leads) keep it secondary.
 */
const reviewIsPrimary = computed(
  () =>
    showReviewEntry.value &&
    isDocumentPresenter.value &&
    reviewBacklog.value.total > 0 &&
    selection.value.ids.length === 0 &&
    !composing.value,
);

/** Secondary actions of the header, in its "Más" menu. */
const moreItems = computed(() => {
  const items: {
    label: string;
    icon: string;
    to?: string;
    onSelect?: () => void;
  }[] = [];
  if (
    canTransact.value &&
    !composing.value &&
    transactionalCandidates.value.length > 0
  ) {
    items.push({
      label: t("workspace.more.transactional"),
      icon: "i-lucide-git-merge",
      onSelect: () => startTransactional([]),
    });
  }
  if (showAnswersEntry.value) {
    items.push({
      label: t("workspace.more.answers"),
      icon: "i-lucide-list-checks",
      to: documentPath("revisar"),
    });
  }
  if (isPublished.value) {
    items.push({
      label: t("workspace.more.consolidated"),
      icon: "i-lucide-file-check",
      to: documentPath("consolidado"),
    });
  }
  if (canEditRecord.value) {
    items.push({
      label: t("workspace.editRecord"),
      icon: "i-lucide-file-cog",
      to: documentPath("editar"),
    });
  }
  return items;
});

function blockReference(blockId: string | null | undefined): string | null {
  if (!blockId) return null;
  const label = labels.value.get(blockId);
  if (!label) return null;
  const paragraph =
    label.paragraph > 0
      ? t("amendment.detail.paragraph", { n: label.paragraph })
      : null;
  return [label.heading, paragraph].filter(Boolean).join(" · ") || null;
}

// Panels ------------------------------------------------------------------------

const mobilePane = ref<Pane>("text");
const listTab = ref<ListTab>("all");
const textMode = ref<TextMode>("original");
const includeAccepted = ref(false);

const paneItems = computed(() => [
  {
    label: t("workspace.panes.text"),
    value: "text",
    icon: "i-lucide-file-text",
  },
  {
    label: t("workspace.panes.amendments"),
    value: "amendments",
    icon: "i-lucide-list-checks",
    badge:
      list.listed.value.length > 0
        ? String(list.listed.value.length)
        : undefined,
  },
]);

const MODE_ICONS: Record<TextMode, string> = {
  original: "i-lucide-file-text",
  amended: "i-lucide-file-diff",
  consolidated: "i-lucide-file-check",
  compare: "i-lucide-columns-2",
};
const TEXT_MODES = Object.keys(MODE_ICONS) as TextMode[];

/** The "Ver" menu: how to show the text, and what the result includes. */
const viewItems = computed(() => {
  const groups = [
    TEXT_MODES.map((mode) => ({
      label: t(`workspace.modes.${mode}`),
      icon: MODE_ICONS[mode],
      type: "checkbox" as const,
      checked: textMode.value === mode,
      onSelect: () => {
        textMode.value = mode;
        // Side by side takes the whole width: the detail would hide it.
        if (mode === "compare") detailOpen.value = false;
      },
    })),
  ];
  if (showAcceptedToggle.value) {
    groups.push([
      {
        label: t("workspace.includeAccepted"),
        icon: "i-lucide-check-check",
        type: "checkbox" as const,
        checked: includeAccepted.value,
        onSelect: () => {
          includeAccepted.value = !includeAccepted.value;
          if (textMode.value === "original" || textMode.value === "amended") {
            textMode.value = "consolidated";
          }
        },
      },
    ]);
  }
  return groups;
});
const textModeLabel = computed(() => t(`workspace.modes.${textMode.value}`));

/** The actor's drafts: corrections asked by the Secretaría, then unsent ones. */
const awaiting = computed(() => amendmentsAwaitingActor(list.mine.value));
const corrections = computed(() => awaiting.value.corrections);

const listTabItems = computed(() => {
  // "Mis enmiendas" counts only what waits for the actor, in warning colour
  // when the Secretaría asked for a correction.
  const waiting = corrections.value.length + awaiting.value.drafts.length;
  return [
    {
      label: t("workspace.tabs.all"),
      value: "all",
      badge: String(list.listed.value.length),
    },
    {
      label: t("workspace.tabs.mine"),
      value: "mine",
      badge:
        waiting > 0
          ? {
              label: String(waiting),
              color:
                corrections.value.length > 0
                  ? ("warning" as const)
                  : ("neutral" as const),
              variant: "subtle" as const,
            }
          : undefined,
    },
  ];
});
const showMineTab = computed(
  () => canAmend.value || list.mine.value.length > 0,
);
/** The actor sees amendments that are not public: offer to filter by review. */
const showReviewFilter = computed(() =>
  list.listed.value.some(isAmendmentPrivate),
);

/**
 * What the Secretaría still has to check or publish in this document, and
 * what it sent back for correction.
 */
const reviewQueue = computed(() => amendmentReviewQueue(list.amendments.value));
const reviewQueueItems = computed(() =>
  (
    [
      {
        filter: "pending_validation",
        count: reviewQueue.value.toValidate,
        icon: "i-lucide-inbox",
        label: t(
          "workspace.reviewQueue.toValidate",
          { count: reviewQueue.value.toValidate },
          reviewQueue.value.toValidate,
        ),
      },
      {
        filter: "validated",
        count: reviewQueue.value.toPublish,
        icon: "i-lucide-eye-off",
        label: t(
          "workspace.reviewQueue.toPublish",
          { count: reviewQueue.value.toPublish },
          reviewQueue.value.toPublish,
        ),
      },
      {
        filter: "correction_requested",
        count: reviewQueue.value.returned,
        icon: "i-lucide-undo-2",
        label: t(
          "workspace.reviewQueue.returned",
          { count: reviewQueue.value.returned },
          reviewQueue.value.returned,
        ),
      },
    ] satisfies {
      filter: AmendmentReviewFilter;
      count: number;
      icon: string;
      label: string;
    }[]
  ).filter((item) => item.count > 0),
);

/** Shows only those amendments, or every one again on a second press. */
function toggleReviewFilter(filter: AmendmentReviewFilter): void {
  const current = list.filters.value.review;
  const review = current === filter ? "any" : filter;
  list.filters.value = {
    ...list.filters.value,
    review,
    // Returned amendments are drafts by other members: a status or member
    // chosen for the normal list would leave this one empty.
    ...(review === "correction_requested"
      ? { statuses: [], memberIds: [] }
      : {}),
  };
}

const panelUi = {
  root: "min-h-0 lg:min-h-0",
  // The body is the containing block of absolute descendants (sr-only text),
  // so they never stretch the panel group and make it scroll on focus.
  body: "relative gap-4 p-4 sm:p-5 overflow-visible lg:overflow-y-auto",
};

// Selection and composer -------------------------------------------------------------

const selection = ref<BlockSelection>({ ids: [], anchor: null });
const composer = ref<ComposerState | null>(null);
let composerSeq = 0;
/** "Presentar una enmienda" was pressed with nothing selected yet. */
const picking = ref(false);

watch(
  () => selection.value.ids.length,
  (count) => {
    if (count > 0) picking.value = false;
  },
);

/** The transactional composer, in the same place (one composer at a time). */
const transactional = ref<TransactionalState | null>(null);
/** Base blocks the transactional being written rewrites, marked in the text. */
const transactionalPassage = ref<string[]>([]);

const composerDraft = computed(() =>
  composer.value?.draftId
    ? (list.byId.value.get(composer.value.draftId) ?? null)
    : null,
);
const composing = computed(
  () => composer.value !== null || transactional.value !== null,
);
const canSelect = computed(
  () => canAmend.value && textMode.value === "original" && !composing.value,
);

function clearSelection(): void {
  selection.value = { ids: [], anchor: null };
}

function onBlockClick(
  blockId: string,
  event: MouseEvent | KeyboardEvent,
): void {
  if (!canSelect.value) return;
  selection.value = extendBlockSelection(
    base.value,
    selection.value,
    blockId,
    event.shiftKey,
  );
}

/** A text selection (drag) inside the original text selects its blocks. */
function onTextPointerUp(): void {
  if (!canSelect.value) return;
  const ids = textView.value?.getSelectedBlockIds() ?? [];
  if (ids.length === 0) return;
  const range = contiguousBlockRange(base.value, ids);
  selection.value = { ids: range, anchor: range[0] ?? null };
}

/** A composer takes the amendments panel, over the original text. */
function showComposerPanel(): void {
  detailOpen.value = false;
  picking.value = false;
  textMode.value = "original";
  mobilePane.value = "amendments";
  // The workspace is as tall as the hub's scroll area: bring all of it into
  // view so the composer's action bar is on screen.
  if (isDesktop.value) {
    void nextTick(() =>
      workspaceBox.value?.scrollIntoView({ block: "nearest" }),
    );
  }
}

function openComposer(options: Partial<Omit<ComposerState, "key">>): void {
  transactional.value = null;
  composer.value = {
    key: (composerSeq += 1),
    mode: "passage",
    selection: [],
    appendParagraph: false,
    draftId: null,
    ...options,
  };
  showComposerPanel();
}

/** "Proponer una transaccional", on these amendments or picking them there. */
function startTransactional(ids: string[]): void {
  if (!canTransact.value) return;
  composer.value = null;
  transactional.value = { key: (composerSeq += 1), sourceIds: [...ids] };
  showComposerPanel();
}

function closeTransactional(): void {
  transactional.value = null;
  transactionalPassage.value = [];
}

function onTransactionalCreated(amendment: AmendmentDto): void {
  list.upsert(amendment);
  // Its sources now link to it: take the server's view of them too.
  void list.refresh();
}

/** "Ver la transaccional": among the actor's own when their member signs it. */
function onTransactionalView(id: string): void {
  closeTransactional();
  const amendment = list.byId.value.get(id);
  if (
    showMineTab.value &&
    amendment &&
    isAmendmentAuthor(amendment, member.value?.id ?? null)
  ) {
    listTab.value = "mine";
  } else {
    listTab.value = "all";
  }
  selectAmendment(id);
  mobilePane.value = "amendments";
}

function amendSelection(
  mode: AmendmentComposerMode = "passage",
  appendParagraph = false,
): void {
  if (selection.value.ids.length === 0) return;
  openComposer({ mode, selection: [...selection.value.ids], appendParagraph });
}

/**
 * The primary action: with a passage selected, amend it; otherwise show the
 * text and ask for the paragraph (the selection bar then offers what to do).
 */
function startAmendment(): void {
  if (selection.value.ids.length > 0) {
    amendSelection("passage");
    return;
  }
  detailOpen.value = false;
  textMode.value = "original";
  mobilePane.value = "text";
  picking.value = true;
  void nextTick(() => {
    selectionBar.value?.scrollIntoView({ block: "nearest" });
    selectionBar.value?.focus({ preventScroll: true });
  });
}

function closeComposer(): void {
  composer.value = null;
}

/** Loads the stored draft into a fresh composer (after a save conflict). */
async function reloadComposer(): Promise<void> {
  const key = composer.value?.key;
  await refreshAll();
  const current = composer.value;
  // Closed, or another composer opened meanwhile: leave that one alone.
  if (!current || current.key !== key) return;
  // A refusal for the document or the assembly: reloading would not help.
  if (
    !isPublished.value ||
    document.value?.finalVote ||
    assembly.value?.status === "closed"
  ) {
    composer.value = null;
    return;
  }
  const stored = current.draftId ? list.byId.value.get(current.draftId) : null;
  if (current.draftId && stored?.status !== "draft") {
    // Presented, withdrawn or deleted meanwhile: show it instead, if visible.
    composer.value = null;
    if (stored) selectAmendment(stored.id);
    return;
  }
  composer.value = { ...current, key: (composerSeq += 1) };
}

function onComposerSaved(amendment: AmendmentDto): void {
  list.upsert(amendment);
  if (composer.value) composer.value.draftId = amendment.id;
}

/** Sent to the Secretaría: show it among the actor's own, with its state. */
function onComposerSubmitted(amendment: AmendmentDto): void {
  list.upsert(amendment);
  composer.value = null;
  clearSelection();
  listTab.value = "mine";
  selectAmendment(amendment.id);
}

/** Amendments that do not start from a paragraph, in the selection bar. */
const otherAmendmentItems = computed(() => [
  [
    {
      label: t("workspace.newMenu.global"),
      icon: "i-lucide-replace-all",
      onSelect: () => openComposer({ mode: "global" }),
    },
  ],
  [
    { type: "label" as const, label: t("workspace.newMenu.totality") },
    {
      label: t("workspace.newMenu.return"),
      icon: "i-lucide-file-x",
      onSelect: () => openComposer({ mode: "return" }),
    },
    {
      label: t("workspace.newMenu.alternative"),
      icon: "i-lucide-file-pen-line",
      onSelect: () => openComposer({ mode: "alternative" }),
    },
  ],
]);

const selectionReference = computed(() =>
  blockReference(selection.value.ids[0]),
);

// Amendment detail -----------------------------------------------------------------

const selectedId = ref<string | null>(null);
const detailOpen = ref(false);
const listHeading = useTemplateRef<HTMLElement>("listHeading");
/**
 * Where the selected card sat in the list it was picked from, so focus can
 * go to its neighbour when it leaves the list (sent back for correction,
 * deleted).
 */
let selectedIndex = -1;

const selectedAmendment = computed(() =>
  selectedId.value ? (list.byId.value.get(selectedId.value) ?? null) : null,
);

/** Ids of the cards in the list on screen, in order. */
function shownIds(): string[] {
  if (listTab.value === "mine" && showMineTab.value) {
    return list.mine.value.map((amendment) => amendment.id);
  }
  return list.groups.value.flatMap((group) =>
    group.amendments.map((amendment) => amendment.id),
  );
}

/**
 * Gives focus back to the list once the detail is gone: the same card, its
 * neighbour, or the list tabs. A slideover returns focus by itself, unless
 * the card it came from left the list.
 */
async function restoreListFocus(id: string | null): Promise<void> {
  await nextTick();
  const box = workspaceBox.value;
  if (!box) return;
  const cards = [
    ...box.querySelectorAll<HTMLElement>("[data-amendment-card]"),
  ].filter((card) => card.offsetParent !== null);
  const target =
    cards.find((card) => card.dataset.amendmentCard === id) ??
    (selectedIndex >= 0
      ? cards[Math.min(selectedIndex, cards.length - 1)]
      : undefined) ??
    box.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
    listHeading.value;
  target?.focus();
}

function onSlideoverClosed(): void {
  const active = globalThis.document?.activeElement;
  if (!active || active === globalThis.document.body) {
    void restoreListFocus(selectedId.value);
  }
}

function scrollToAmendment(amendment: AmendmentDto): void {
  const first = touchedBlockIds(amendment.ops)[0];
  if (!first) return;
  void nextTick(() => textView.value?.scrollToBlock(first));
}

function selectAmendment(
  id: string,
  options: { fromText?: boolean } = {},
): void {
  selectedId.value = id;
  if (composing.value) return;
  if (!options.fromText) selectedIndex = shownIds().indexOf(id);
  detailOpen.value = true;
  const amendment = list.byId.value.get(id);
  if (!options.fromText && textMode.value === "original") {
    textMode.value = "amended";
  }
  if (amendment && !options.fromText && isDesktop.value) {
    scrollToAmendment(amendment);
  }
}

function closeDetail(): void {
  const inPanel = showDesktopDetail.value;
  detailOpen.value = false;
  if (inPanel) void restoreListFocus(selectedId.value);
}

function onDetailRemoved(id: string): void {
  const inPanel = showDesktopDetail.value;
  list.remove(id);
  if (selectedId.value === id) selectedId.value = null;
  detailOpen.value = false;
  if (inPanel) void restoreListFocus(null);
}

/** "Ver qué corregir": the first correction, among the actor's own. */
function openCorrections(): void {
  const first = corrections.value[0];
  if (!first) return;
  listTab.value = "mine";
  selectAmendment(first.id);
  mobilePane.value = "amendments";
}

/**
 * On arrival, `?enmienda=<id>` opens that amendment (a draft of the
 * actor's own in "Mis enmiendas"; one sent back for correction they cannot
 * edit in "Todas", under "Devueltas para corregir"), and
 * `?transaccional=<id>,<id>` the transactional composer
 * on those amendments (the ones that can still be combined). Client only:
 * whether the detail opens in the panel or in a slideover depends on the
 * screen width.
 */
let landed = false;
function landOnAmendment(): void {
  if (landed || !list.data.value || !document.value) return;
  landed = true;
  const transact = route.query.transaccional;
  if (typeof transact === "string" && canTransact.value) {
    startTransactional(
      transact.split(",").filter((id) => {
        const amendment = list.byId.value.get(id);
        return (
          amendment !== undefined && transactionalSourceEligible(amendment)
        );
      }),
    );
    return;
  }
  const wanted = route.query.enmienda;
  const id = typeof wanted === "string" ? wanted : null;
  const target = id ? list.byId.value.get(id) : undefined;
  if (!target) return;
  const isTarget = (amendment: AmendmentDto) => amendment.id === target.id;
  if (target.status === "draft" && list.mine.value.some(isTarget)) {
    listTab.value = "mine";
  } else if (list.returned.value.some(isTarget)) {
    // Set before selecting, which reads the list on screen.
    listTab.value = "all";
    list.filters.value = {
      ...list.filters.value,
      review: "correction_requested",
    };
  }
  selectAmendment(target.id);
  mobilePane.value = "amendments";
}
onMounted(() => {
  watch([() => list.data.value, () => document.value], landOnAmendment, {
    immediate: true,
  });
});

function onDetailEdit(amendment: AmendmentDto): void {
  openComposer({ draftId: amendment.id });
}

const showDesktopDetail = computed(
  () =>
    isDesktop.value &&
    detailOpen.value &&
    !composing.value &&
    selectedAmendment.value !== null,
);
const mobileDetailOpen = computed({
  get: () =>
    !isDesktop.value &&
    detailOpen.value &&
    !composing.value &&
    selectedAmendment.value !== null,
  set: (open: boolean) => {
    if (!open) detailOpen.value = false;
  },
});

/**
 * "Original y resultado" on a wide screen, with no amendment or composer
 * open: the text takes the whole workspace so the two columns fit side by
 * side. Opening an amendment or a composer brings the list back.
 */
const wideCompare = computed(
  () =>
    isDesktop.value &&
    textMode.value === "compare" &&
    !composing.value &&
    !detailOpen.value,
);
const textPanelClass = computed(() =>
  [
    mobilePane.value === "text" ? "flex" : "hidden lg:flex",
    wideCompare.value ? "lg:w-full lg:not-last:border-e-0" : "",
  ].join(" "),
);
const amendmentsPanelClass = computed(() =>
  [
    mobilePane.value === "amendments" ? "flex" : "hidden lg:flex",
    wideCompare.value ? "lg:hidden" : "",
  ].join(" "),
);

/**
 * The open amendment in the address (`?enmienda=<id>`), so its link can be
 * shared. Replaced, not pushed: Back leaves the page instead of walking
 * through every card opened. Not run on arrival, so the query that opens
 * an amendment is read first.
 */
watch(
  () => (detailOpen.value ? selectedId.value : null),
  (id) => {
    if ((route.query.enmienda ?? null) === id) return;
    void router.replace({
      query: {
        ...route.query,
        transaccional: undefined,
        enmienda: id ?? undefined,
      },
    });
  },
);

const relationCandidates = computed(() =>
  list.listed.value.filter((amendment) => amendment.id !== selectedId.value),
);

/** Markers count the listed amendments: filter those, not the returned ones. */
function onMarkerClick(blockId: string): void {
  const { review } = list.filters.value;
  list.filters.value = {
    ...list.filters.value,
    blockId,
    review: review === "correction_requested" ? "any" : review,
  };
  listTab.value = "all";
  detailOpen.value = false;
  mobilePane.value = "amendments";
}

// Text views -----------------------------------------------------------------------

const amendedAnnotated = computed(() => {
  const amendment = selectedAmendment.value;
  if (!amendment || amendment.ops.length === 0 || base.value.length === 0) {
    return null;
  }
  if (validateOps(base.value, amendment.ops).length > 0) return null;
  return consolidate(base.value, [{ id: amendment.id, ops: amendment.ops }])
    .annotated;
});

const selectedOverlaps = computed(() =>
  selectedId.value ? (list.overlaps.value.get(selectedId.value) ?? []) : [],
);

const overlapBlockIds = computed(() => {
  const amendment = selectedAmendment.value;
  if (!amendment) return [];
  const own = new Set(touchedBlockIds(amendment.ops));
  const ids = new Set<string>();
  for (const overlap of selectedOverlaps.value) {
    const other = list.byId.value.get(overlap.id);
    if (!other) continue;
    for (const id of touchedBlockIds(other.ops)) {
      if (own.has(id)) ids.add(id);
    }
  }
  return [...ids];
});

const consolidation = computed(() =>
  base.value.length > 0
    ? consolidate(
        base.value,
        consolidationInputs(
          list.amendments.value,
          includeAccepted.value && showAcceptedToggle.value,
        ),
      )
    : null,
);
const compareBlocks = computed(
  () => finalText.value ?? consolidation.value?.blocks ?? [],
);
/**
 * "Incluir las aceptadas" previews the amendments the main presenter accepted
 * as if approved. Under the "incorporate" rule accepting already approves
 * them, so there is nothing to add.
 */
const showAcceptedToggle = computed(
  () =>
    !finalText.value &&
    Boolean(document.value?.positionsVisible) &&
    document.value?.acceptedAmendments !== "incorporate",
);

const originalSelected = computed(() => {
  if (transactional.value) return transactionalPassage.value;
  return composer.value &&
    (composer.value.mode === "passage" || composer.value.mode === "delete")
    ? contiguousBlockRange(base.value, composer.value.selection)
    : selection.value.ids;
});

const fallbackText = computed(
  () => document.value?.workingVersion?.blocks ?? null,
);

// Live list announcement --------------------------------------------------------------

const listAnnouncement = computed(() =>
  list.pending.value
    ? ""
    : t(
        "amendment.list.count",
        { count: list.filtered.value.length },
        list.filtered.value.length,
      ),
);

const filteredBlockLabel = computed(() =>
  blockReference(list.filters.value.blockId),
);
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- Loading -->
    <div v-if="pending" class="flex flex-col gap-4" role="status">
      <span class="sr-only">{{ t("workspace.loading") }}</span>
      <USkeleton aria-hidden="true" class="h-4 w-32" />
      <USkeleton aria-hidden="true" class="h-8 w-3/4 max-w-xl" />
      <USkeleton aria-hidden="true" class="h-12 w-full" />
      <div class="grid gap-4 lg:grid-cols-[3fr_2fr]">
        <USkeleton aria-hidden="true" class="h-[28rem] w-full" />
        <USkeleton
          aria-hidden="true"
          class="hidden h-[28rem] w-full lg:block"
        />
      </div>
    </div>

    <!-- Error -->
    <CommonEmptyState
      v-else-if="!document || !assembly"
      :icon="
        errorStatusCode === 404
          ? 'i-lucide-file-question'
          : 'i-lucide-cloud-off'
      "
      :title="
        errorStatusCode === 404
          ? t('workspace.notFound')
          : t('workspace.loadError')
      "
      :description="
        errorStatusCode === 404
          ? t('workspace.notFoundDescription')
          : t('workspace.loadErrorDescription')
      "
    >
      <template #action>
        <UButton
          v-if="errorStatusCode !== 404"
          icon="i-lucide-refresh-ccw"
          :label="t('workspace.retry')"
          @click="refreshAll"
        />
        <UButton
          :to="workspace.hub.sectionPath('documentos')"
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :label="t('workspace.backToDocuments')"
        />
      </template>
    </CommonEmptyState>

    <template v-else>
      <DocumentHeader
        :document="document"
        :assembly="assembly"
        :edit-to="canEditDraft ? documentPath('editar') : null"
      >
        <div class="flex flex-col items-start gap-1.5 sm:items-end">
          <div class="flex flex-wrap items-center gap-2">
            <!-- The presenter's review: primary while something waits for
                 the presenter, secondary for the Mesa. -->
            <UButton
              v-if="showReviewEntry"
              :to="documentPath('revisar')"
              icon="i-lucide-list-checks"
              :color="reviewIsPrimary ? 'primary' : 'neutral'"
              :variant="reviewIsPrimary ? 'solid' : 'outline'"
              :label="t('workspace.proponentReview.action')"
              :aria-label="
                reviewBacklog.total > 0
                  ? t(
                      'workspace.proponentReview.actionCount',
                      { count: reviewBacklog.total },
                      reviewBacklog.total,
                    )
                  : undefined
              "
            >
              <template v-if="reviewBacklog.total > 0" #trailing>
                <UBadge
                  :label="String(reviewBacklog.total)"
                  :color="reviewIsPrimary ? 'neutral' : 'primary'"
                  :variant="reviewIsPrimary ? 'solid' : 'subtle'"
                  size="sm"
                  class="tabular-nums"
                  aria-hidden="true"
                />
              </template>
            </UButton>
            <!-- With a paragraph picked, the selection bar's "Cambiar este
                 texto" is the primary button; with the presenter's review
                 pending, that one is. -->
            <UButton
              v-if="canAmend && isStructured && !composing"
              icon="i-lucide-pencil-line"
              :variant="
                selection.ids.length > 0 || reviewIsPrimary
                  ? 'outline'
                  : 'solid'
              "
              :label="t('workspace.cta.present')"
              @click="startAmendment"
            />
            <!-- A presented document waits for the Secretaría: its button
                 says what it does there. -->
            <UButton
              v-else-if="canEditDraft && !headerHasNextStep"
              :to="documentPath('editar')"
              :icon="reviewing ? 'i-lucide-badge-check' : 'i-lucide-pencil'"
              :label="
                reviewing
                  ? t('workspace.reviewAndValidate')
                  : t('workspace.editDraft')
              "
            />
            <!-- The text as a PDF: the published one, or the draft for
                 managers (canExportWorkingDraft). -->
            <ExportButton
              v-if="
                isStructured &&
                (document.can.manage || Boolean(document.baseVersion))
              "
              :assembly="assembly.id"
              :document="document.id"
              variant="clean"
              button-variant="outline"
            />
            <UDropdownMenu
              v-if="moreItems.length > 0"
              :items="moreItems"
              :content="{ align: 'end' }"
            >
              <UButton
                icon="i-lucide-ellipsis"
                trailing-icon="i-lucide-chevron-down"
                color="neutral"
                variant="outline"
                :label="t('workspace.more.label')"
              />
            </UDropdownMenu>
          </div>
        </div>
      </DocumentHeader>

      <p
        v-if="document.summary"
        class="text-muted max-w-3xl text-sm whitespace-pre-line"
      >
        {{ document.summary }}
      </p>

      <AmendmentWindowBanner :document="document" />

      <!-- Uploaded PDF -->
      <CommonEmptyState
        v-if="document.format === 'file'"
        icon="i-lucide-file-text"
        :title="t('workspace.text.file')"
        :description="
          document.fileUrl
            ? t('workspace.text.fileDescription')
            : t('workspace.text.filePending')
        "
        variant="outline"
      >
        <template v-if="document.fileUrl" #action>
          <UButton
            :to="document.fileUrl"
            external
            target="_blank"
            icon="i-lucide-external-link"
            :label="t('workspace.text.openPdf')"
          />
        </template>
      </CommonEmptyState>

      <!-- Not published yet -->
      <template v-else-if="!isPublished">
        <!-- Not while it is back with its presenters: the header says so. -->
        <UAlert
          v-if="document.amendable && !document.correctionRequestedAt"
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          :title="t('workspace.text.unpublished')"
          :description="t('workspace.text.unpublishedDescription')"
        />
        <div
          v-if="fallbackText && fallbackText.length > 0"
          class="border-default rounded-lg border p-4 sm:p-6"
        >
          <template v-if="draftOutline.length > 1">
            <!-- Marks in the box's left margin, kept in view as the draft
                 scrolls; they take no room of their own. -->
            <div class="sticky top-4 z-20 -ms-5 h-0 max-sm:hidden">
              <ContentOutlineRail
                :items="draftOutline"
                :current="() => draftView?.currentHeading() ?? null"
                @select="
                  (id) => draftView?.scrollToBlock(id, { align: 'start' })
                "
              />
            </div>
            <!-- No margin for them on a narrow screen: a floating button. -->
            <div class="sticky top-3 z-10 mb-3 w-fit sm:hidden">
              <ContentOutline
                :items="draftOutline"
                :current="() => draftView?.currentHeading() ?? null"
                @select="
                  (id) => draftView?.scrollToBlock(id, { align: 'start' })
                "
              />
            </div>
          </template>
          <ContentView ref="draftView" :blocks="fallbackText" />
        </div>
        <CommonEmptyState
          v-else
          icon="i-lucide-file-clock"
          :title="t('workspace.text.empty')"
          variant="outline"
        />
      </template>

      <!-- Workspace -->
      <template v-else>
        <!-- The Secretaría sent some of the actor's amendments back. -->
        <UAlert
          v-if="corrections.length > 0 && canAmend && !composing"
          color="warning"
          variant="subtle"
          icon="i-lucide-message-square-warning"
          :title="
            t(
              'workspace.corrections.title',
              { count: corrections.length },
              corrections.length,
            )
          "
          :description="
            t('workspace.corrections.description', corrections.length)
          "
          :actions="[
            {
              label: t('workspace.corrections.action'),
              icon: 'i-lucide-pencil-line',
              color: 'neutral',
              variant: 'outline',
              onClick: openCorrections,
            },
          ]"
        />

        <UTabs
          v-model="mobilePane"
          :items="paneItems"
          :content="false"
          size="sm"
          class="lg:hidden"
          :aria-label="t('workspace.panes.label')"
        />

        <!-- The index on narrow screens, floating at the corner while the text
             scrolls with the page. -->
        <div
          v-if="textOutline.length > 1 && mobilePane === 'text'"
          class="fixed start-4 bottom-4 z-30 lg:hidden"
        >
          <ContentOutline
            :items="textOutline"
            :current="() => textView?.currentHeading() ?? null"
            @select="(id) => textView?.scrollToBlock(id, { align: 'start' })"
          />
        </div>

        <!-- As tall as the hub body's scroll area (viewport minus navbar,
             section toolbar and padding), like the session console. -->
        <div
          ref="workspaceBox"
          class="border-default flex flex-col overflow-hidden rounded-lg border lg:h-[calc(100dvh-var(--ui-header-height)-3rem)] lg:min-h-[32rem] lg:flex-row"
        >
          <!-- Text -->
          <UDashboardPanel
            id="document-workspace-text"
            :resizable="!wideCompare"
            :default-size="58"
            :min-size="35"
            :max-size="72"
            :class="textPanelClass"
            :ui="panelUi"
          >
            <template #header>
              <UDashboardToolbar
                :ui="{
                  root: 'flex-wrap gap-2 py-2 min-h-12 h-auto',
                  left: 'flex-wrap',
                  right: 'flex-wrap',
                }"
              >
                <template #left>
                  <UDropdownMenu
                    :items="viewItems"
                    :content="{ align: 'start' }"
                  >
                    <UButton
                      color="neutral"
                      variant="ghost"
                      size="sm"
                      :icon="MODE_ICONS[textMode]"
                      trailing-icon="i-lucide-chevron-down"
                      :label="textModeLabel"
                      :aria-label="
                        t('workspace.modes.button', { mode: textModeLabel })
                      "
                    />
                  </UDropdownMenu>
                </template>
                <template #right>
                  <UBadge
                    v-if="
                      includeAccepted &&
                      showAcceptedToggle &&
                      (textMode === 'consolidated' || textMode === 'compare')
                    "
                    color="neutral"
                    variant="soft"
                    size="sm"
                    icon="i-lucide-check-check"
                    :label="t('workspace.includeAcceptedOn')"
                  />
                </template>
              </UDashboardToolbar>
            </template>

            <template #body>
              <!-- The index as marks in the panel's left margin, kept in
                   view as the text scrolls; no room of their own (the body
                   is a column with gaps). Narrow screens float a button
                   instead (above). -->
              <div
                v-if="textOutline.length > 1"
                class="sticky top-2 z-20 -ms-5 -mb-4 h-0 max-lg:hidden"
              >
                <ContentOutlineRail
                  :items="textOutline"
                  :current="() => textView?.currentHeading() ?? null"
                  @select="
                    (id) => textView?.scrollToBlock(id, { align: 'start' })
                  "
                />
              </div>

              <!-- Original -->
              <template v-if="textMode === 'original'">
                <div
                  v-if="canAmend && !composing"
                  ref="selectionBar"
                  tabindex="-1"
                  class="bg-default/95 sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 backdrop-blur transition-shadow focus-visible:outline-none"
                  :class="
                    picking
                      ? 'border-primary ring-primary/40 ring-2'
                      : 'border-default'
                  "
                  role="region"
                  :aria-label="t('workspace.selection.label')"
                >
                  <template v-if="selection.ids.length > 0">
                    <span class="text-sm font-medium" aria-live="polite">
                      {{
                        t(
                          "workspace.selection.count",
                          { count: selection.ids.length },
                          selection.ids.length,
                        )
                      }}
                      <span
                        v-if="selectionReference"
                        class="text-muted font-normal"
                      >
                        · {{ selectionReference }}
                      </span>
                    </span>
                    <span class="ms-auto flex flex-wrap items-center gap-1.5">
                      <UButton
                        icon="i-lucide-pencil-line"
                        size="sm"
                        :label="t('workspace.selection.amend')"
                        @click="amendSelection('passage')"
                      />
                      <UButton
                        icon="i-lucide-between-horizontal-end"
                        color="neutral"
                        variant="outline"
                        size="sm"
                        :label="t('workspace.selection.addAfter')"
                        @click="amendSelection('passage', true)"
                      />
                      <UButton
                        icon="i-lucide-trash-2"
                        color="neutral"
                        variant="outline"
                        size="sm"
                        :label="
                          t('workspace.selection.delete', selection.ids.length)
                        "
                        @click="amendSelection('delete')"
                      />
                      <UButton
                        icon="i-lucide-x"
                        color="neutral"
                        variant="ghost"
                        size="xs"
                        :aria-label="t('workspace.selection.clear')"
                        @click="clearSelection"
                      />
                    </span>
                  </template>
                  <template v-else>
                    <p
                      class="min-w-0 flex-1 text-sm"
                      :class="picking ? 'text-highlighted' : 'text-muted'"
                      aria-live="polite"
                    >
                      <UIcon
                        name="i-lucide-mouse-pointer-click"
                        class="me-1 size-4 align-text-bottom"
                        aria-hidden="true"
                      />
                      {{ t("workspace.selection.hint") }}
                      <span class="text-dimmed hidden text-xs sm:inline">
                        {{ t("workspace.selection.rangeHint") }}
                      </span>
                    </p>
                    <UDropdownMenu
                      :items="otherAmendmentItems"
                      :content="{ align: 'end' }"
                    >
                      <UButton
                        color="neutral"
                        variant="ghost"
                        size="sm"
                        trailing-icon="i-lucide-chevron-down"
                        :label="t('workspace.newMenu.label')"
                      />
                    </UDropdownMenu>
                  </template>
                </div>

                <div @mouseup="onTextPointerUp" @keyup.shift="onTextPointerUp">
                  <ContentView
                    ref="textView"
                    :blocks="base"
                    :markers="list.markers.value"
                    :selected="originalSelected"
                    :interactive="canSelect"
                    @block-click="onBlockClick"
                    @marker-click="onMarkerClick"
                  />
                </div>
              </template>

              <!-- One amendment over the full text -->
              <template v-else-if="textMode === 'amended'">
                <CommonEmptyState
                  v-if="!selectedAmendment"
                  icon="i-lucide-mouse-pointer-click"
                  :title="t('workspace.amended.empty')"
                  :description="t('workspace.amended.emptyDescription')"
                  size="sm"
                />
                <template v-else>
                  <div class="flex flex-col gap-2">
                    <p class="text-sm">
                      {{
                        t("workspace.amended.showing", {
                          label: list.labelOf(selectedAmendment.id),
                        })
                      }}
                    </p>
                    <div
                      v-if="selectedOverlaps.length > 0"
                      class="flex flex-wrap items-center gap-1.5"
                    >
                      <span class="text-warning text-sm">
                        <UIcon
                          name="i-lucide-layers"
                          class="me-1 size-4 align-text-bottom"
                          aria-hidden="true"
                        />
                        {{ t("workspace.amended.overlaps") }}
                      </span>
                      <UButton
                        v-for="overlap in selectedOverlaps"
                        :key="overlap.id"
                        size="xs"
                        color="warning"
                        variant="soft"
                        :label="list.labelOf(overlap.id)"
                        @click="selectAmendment(overlap.id)"
                      />
                    </div>
                  </div>
                  <UAlert
                    v-if="selectedAmendment.kind === 'totality_return'"
                    color="neutral"
                    variant="subtle"
                    icon="i-lucide-file-x"
                    :title="t('amendment.kinds.totality_return')"
                    :description="t('amendment.detail.returnNote')"
                  />
                  <UAlert
                    v-else-if="!amendedAnnotated"
                    color="warning"
                    variant="subtle"
                    icon="i-lucide-triangle-alert"
                    :title="t('workspace.amended.invalid')"
                  />
                  <ContentView
                    v-if="amendedAnnotated"
                    ref="textView"
                    :annotated="amendedAnnotated"
                    mode="diff"
                    :focus="selectedAmendment.id"
                    :selected="overlapBlockIds"
                  />
                </template>
              </template>

              <!-- Live consolidation -->
              <template
                v-else-if="textMode === 'consolidated' && consolidation"
              >
                <UAlert
                  v-if="finalText"
                  color="success"
                  variant="subtle"
                  icon="i-lucide-badge-check"
                  :title="t('workspace.consolidated.final')"
                />
                <UAlert
                  v-else-if="consolidation.applied.length === 0"
                  color="neutral"
                  variant="subtle"
                  icon="i-lucide-info"
                  :title="t('workspace.consolidated.none')"
                />
                <p v-else class="text-muted text-sm">
                  {{
                    t(
                      "workspace.consolidated.applied",
                      { count: consolidation.applied.length },
                      consolidation.applied.length,
                    )
                  }}
                </p>
                <UAlert
                  v-if="consolidation.conflicts.length > 0"
                  color="warning"
                  variant="subtle"
                  icon="i-lucide-triangle-alert"
                  :title="t('workspace.consolidated.conflicts')"
                >
                  <template #description>
                    <ul class="list-disc ps-5">
                      <li
                        v-for="conflict in consolidation.conflicts"
                        :key="conflict.amendmentId"
                      >
                        {{
                          conflict.conflictsWith.length > 0
                            ? t("workspace.consolidated.conflictWith", {
                                label: list.labelOf(conflict.amendmentId),
                                others: conflict.conflictsWith
                                  .map((id) => list.labelOf(id))
                                  .join(", "),
                              })
                            : t("workspace.consolidated.conflictInvalid", {
                                label: list.labelOf(conflict.amendmentId),
                              })
                        }}
                      </li>
                    </ul>
                  </template>
                </UAlert>
                <ContentView
                  ref="textView"
                  :annotated="consolidation.annotated"
                  mode="provenance"
                  :label="list.shortLabelOf"
                  :focus="selectedId"
                  interactive
                  @amendment-click="selectAmendment($event, { fromText: true })"
                />
              </template>

              <!-- Side by side -->
              <div v-else-if="textMode === 'compare'" class="@container">
                <div class="grid gap-6 @3xl:grid-cols-2">
                  <section class="min-w-0">
                    <h3
                      class="text-muted mb-3 text-xs font-semibold tracking-wide uppercase"
                    >
                      {{ t("workspace.compare.original") }}
                    </h3>
                    <ContentView :blocks="base" />
                  </section>
                  <section
                    class="border-default min-w-0 border-t pt-6 @3xl:border-t-0 @3xl:border-s @3xl:ps-6 @3xl:pt-0"
                  >
                    <h3
                      class="text-muted mb-3 text-xs font-semibold tracking-wide uppercase"
                    >
                      {{
                        finalText
                          ? t("workspace.compare.final")
                          : t("workspace.compare.consolidated")
                      }}
                    </h3>
                    <ContentView :blocks="compareBlocks" />
                  </section>
                </div>
              </div>
            </template>
          </UDashboardPanel>

          <!-- Amendments -->
          <UDashboardPanel
            id="document-workspace-amendments"
            :class="amendmentsPanelClass"
            :ui="panelUi"
          >
            <template v-if="!composing && !showDesktopDetail" #header>
              <UDashboardToolbar
                :ui="{
                  root: 'flex-wrap gap-2 py-2 min-h-12 h-auto',
                  left: 'flex-wrap',
                  right: 'flex-wrap',
                }"
              >
                <template #left>
                  <UTabs
                    v-if="showMineTab"
                    v-model="listTab"
                    :items="listTabItems"
                    :content="false"
                    variant="link"
                    size="sm"
                    :aria-label="t('workspace.tabs.label')"
                  />
                  <h2
                    v-else
                    ref="listHeading"
                    tabindex="-1"
                    class="text-highlighted text-sm font-semibold outline-none"
                  >
                    {{ t("workspace.panes.amendments") }}
                  </h2>
                </template>
              </UDashboardToolbar>
            </template>

            <template #body>
              <!-- Composer -->
              <AmendmentComposer
                v-if="composer"
                :key="composer.key"
                :base="base"
                :document="document"
                :amendments-url="amendmentsUrl"
                :mode="composer.mode"
                :selection="composer.selection"
                :append-paragraph="composer.appendParagraph"
                :draft="composerDraft"
                @close="closeComposer"
                @saved="onComposerSaved"
                @submitted="onComposerSubmitted"
                @conflict="refreshAll()"
                @reload="reloadComposer"
              />

              <!-- Transactional composer -->
              <TransactionalComposer
                v-else-if="transactional"
                :key="transactional.key"
                :base="base"
                :document="document"
                :amendments-url="amendmentsUrl"
                :amendments="list.listed.value"
                :label-of="list.labelOf"
                :initial-source-ids="transactional.sourceIds"
                @close="closeTransactional"
                @created="onTransactionalCreated"
                @view="onTransactionalView"
                @conflict="refreshAll()"
                @passage="transactionalPassage = $event"
              />

              <!-- Detail (wide screens) -->
              <AmendmentDetail
                v-else-if="showDesktopDetail && selectedAmendment"
                :amendment="selectedAmendment"
                :base="base"
                :document="document"
                :amendments-url="amendmentsUrl"
                :label-of="list.labelOf"
                :relations="list.relationsOf(selectedAmendment.id)"
                :candidates="relationCandidates"
                :overlaps="selectedOverlaps"
                :decisions-url="decisionsUrl"
                :can-transact="canTransact"
                @close="closeDetail"
                @select="selectAmendment"
                @edit="onDetailEdit"
                @transact="startTransactional"
                @updated="list.upsert"
                @replaced="list.replace"
                @removed="onDetailRemoved"
                @changed="refreshAll()"
              />

              <!-- My amendments: drafts, corrections and where the rest stand -->
              <template v-else-if="listTab === 'mine' && showMineTab">
                <CommonEmptyState
                  v-if="list.mine.value.length === 0"
                  icon="i-lucide-file-pen"
                  :title="t('workspace.mine.empty')"
                  :description="
                    canAmend ? t('workspace.mine.emptyDescription') : undefined
                  "
                  size="sm"
                />
                <ul
                  v-else
                  class="flex flex-col gap-2"
                  :aria-label="t('workspace.tabs.mine')"
                >
                  <li v-for="item in list.mine.value" :key="item.id">
                    <AmendmentCard
                      :amendment="item"
                      :label="list.labelOf(item.id)"
                      :label-of="list.labelOf"
                      :relations="list.relationsOf(item.id)"
                      :selected="selectedId === item.id"
                      :status-of="amendmentStatusOf"
                      :by-id="list.byId.value"
                      :presenter="document.proponent?.acronym ?? null"
                      show-published
                      @select="selectAmendment"
                    />
                  </li>
                </ul>
              </template>

              <!-- All amendments -->
              <template v-else>
                <!-- Secretaría: what it still has to check or publish, and
                     what it sent back for correction. -->
                <div
                  v-if="reviewQueueItems.length > 0"
                  class="flex flex-wrap items-center gap-x-2 gap-y-1.5"
                  role="group"
                  :aria-label="t('amendment.review.label')"
                >
                  <span class="text-muted text-sm" aria-hidden="true">
                    {{ t("amendment.review.label") }}:
                  </span>
                  <UButton
                    v-for="item in reviewQueueItems"
                    :key="item.filter"
                    size="xs"
                    color="neutral"
                    :variant="
                      list.filters.value.review === item.filter
                        ? 'subtle'
                        : 'ghost'
                    "
                    :icon="item.icon"
                    :label="item.label"
                    :aria-pressed="list.filters.value.review === item.filter"
                    @click="toggleReviewFilter(item.filter)"
                  />
                </div>

                <AmendmentFilterBar
                  v-model="list.filters.value"
                  :author-options="list.authorOptions.value"
                  :can-filter-mine="Boolean(member)"
                  :show-review-filter="showReviewFilter"
                  :show-returned-filter="list.returned.value.length > 0"
                  :block-label="filteredBlockLabel"
                />
                <p class="sr-only" aria-live="polite">{{ listAnnouncement }}</p>

                <div
                  v-if="
                    list.pending.value && list.amendments.value.length === 0
                  "
                  class="flex flex-col gap-3"
                  role="status"
                >
                  <span class="sr-only">{{ t("amendment.list.loading") }}</span>
                  <USkeleton
                    v-for="i in 4"
                    :key="i"
                    aria-hidden="true"
                    class="h-24 w-full"
                  />
                </div>

                <UAlert
                  v-else-if="
                    list.error.value && list.amendments.value.length === 0
                  "
                  color="error"
                  variant="subtle"
                  icon="i-lucide-circle-alert"
                  role="alert"
                  :title="t('amendment.list.error')"
                  :actions="[
                    {
                      label: t('amendment.actions.retry'),
                      icon: 'i-lucide-refresh-ccw',
                      color: 'neutral',
                      variant: 'outline',
                      onClick: () => {
                        void list.refresh();
                      },
                    },
                  ]"
                />

                <CommonEmptyState
                  v-else-if="list.source.value.length === 0"
                  icon="i-lucide-message-square-dashed"
                  :title="t('amendment.list.empty')"
                  :description="
                    canAmend
                      ? t('amendment.list.emptyCanAmend')
                      : t('amendment.list.emptyDescription')
                  "
                  size="sm"
                />

                <CommonEmptyState
                  v-else-if="list.filtered.value.length === 0"
                  icon="i-lucide-filter-x"
                  :title="t('amendment.list.emptyFiltered')"
                  size="sm"
                >
                  <template #action>
                    <UButton
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-filter-x"
                      :label="t('amendment.filters.clear')"
                      @click="list.resetFilters()"
                    />
                  </template>
                </CommonEmptyState>

                <AmendmentList
                  v-else
                  :groups="list.groups.value"
                  :selected-id="selectedId"
                  :label-of="list.labelOf"
                  :relations-of="list.relationsOf"
                  :can-transact="canTransact"
                  :status-of="amendmentStatusOf"
                  :by-id="list.byId.value"
                  :presenter="document.proponent?.acronym ?? null"
                  @select="selectAmendment"
                  @transact="startTransactional"
                />
              </template>
            </template>
          </UDashboardPanel>
        </div>

        <!-- Detail (narrow screens) -->
        <USlideover
          v-model:open="mobileDetailOpen"
          side="right"
          :title="selectedAmendment ? list.labelOf(selectedAmendment.id) : ''"
          :description="t('workspace.detailDescription')"
          :ui="{ content: 'max-w-full sm:max-w-lg', body: 'p-4 sm:p-6' }"
          @after:leave="onSlideoverClosed"
        >
          <template #body>
            <AmendmentDetail
              v-if="selectedAmendment"
              :amendment="selectedAmendment"
              :base="base"
              :document="document"
              :amendments-url="amendmentsUrl"
              :label-of="list.labelOf"
              :relations="list.relationsOf(selectedAmendment.id)"
              :candidates="relationCandidates"
              :overlaps="selectedOverlaps"
              :decisions-url="decisionsUrl"
              :closable="false"
              :can-transact="canTransact"
              @close="closeDetail"
              @select="selectAmendment"
              @edit="onDetailEdit"
              @transact="startTransactional"
              @updated="list.upsert"
              @replaced="list.replace"
              @removed="onDetailRemoved"
              @changed="refreshAll()"
            />
          </template>
        </USlideover>
      </template>
    </template>
  </div>
</template>
