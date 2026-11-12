<script setup lang="ts">
import type { OutlineEntry } from "~/components/content/ContentView.vue";
import type {
  AmendmentComposerAuthorsDto,
  AmendmentDto,
} from "~~/shared/types/api";
import { consolidate } from "~~/shared/utils/content/consolidate";
import {
  firstTouchedBlockId,
  touchedBlockIds,
  validateOps,
} from "~~/shared/utils/content/ops";
import { blockLabels } from "~~/shared/utils/content/render";
import { kindAcceptsFile } from "~~/shared/utils/documentFormat";
import {
  proponentReviewBacklog,
  transactionalSourceCandidates,
  transactionalSourceEligible,
} from "~/composables/amendment/transactional";
import {
  amendmentNeighbours,
  amendmentReviewQueue,
  amendmentsAwaitingActor,
  applyAmendmentQuickFilter,
  consolidationInputs,
  isAmendmentAuthor,
  isAmendmentPrivate,
  type AmendmentComposerMode,
  type AmendmentReviewFilter,
} from "~/composables/amendment/workspace";
import {
  DOCUMENT_AMEND_QUERY,
  DOCUMENT_AMEND_SELECTION_QUERY,
  parseAmendSelection,
  type TextSpan,
  DOCUMENT_AMENDMENTS_QUERY,
  DOCUMENT_AMENDMENTS_UNREAD,
} from "~/composables/document/documentLinks";
import {
  documentAudience,
  documentProgress,
} from "~/composables/document/documentProgress";

/**
 * Document workspace (inside the assembly hub). Its one primary action, for
 * those who can amend, is "Presentar enmienda": it opens the whole text in
 * an editor (AmendmentComposer) in place of the text and the list, at the
 * paragraph the reader had at the top of the text (or the one they had
 * selected). Over the original text the same editor opens from the text
 * itself (AmendmentTextActions): a right click on it offers "Hacer
 * enmienda aquí", at that paragraph and with the text the reader had
 * selected, if any, selected in the editor too. Everything changed there is one amendment. Under the button,
 * three links with a sentence each open the other ways to amend: changing a
 * word everywhere, sending the document back and proposing an alternative
 * text.
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
 * presenter, and the Mesa) is a secondary action with a visible button: in
 * the header, on a group of amendments on the same passage, and in an
 * amendment's detail. Its composer opens in
 * place of the list, with the passage it rewrites marked in the text.
 *
 * The text is on the left, with four views as visible tabs (original with
 * gutter markers, one amendment over the full text, live consolidation with
 * provenance, side by side: on wide screens it takes the whole workspace
 * until an amendment or a composer is opened). The view only changes when
 * the reader picks a tab or presses "Ver en el documento" in an amendment's
 * detail, never by selecting an amendment. The
 * original text marks in its margin, with a thin line, the paragraphs that
 * undecided amendments act on (pressing one lists them); "Enmiendas en el
 * margen" turns the lines off, per browser. The
 * amendments are on the right, grouped by the passage they act on, under
 * visible chips: "Todas", "Pendientes", "Sin leer" and "Fuera de plazo"
 * filter the list, "Mías" shows where the actor's own stand with the Secretaría
 * (its badge counts what waits for them), and "Más filtros" holds the rest.
 * An open amendment takes the panel and is read on its own: "Anterior ·
 * 3 de 17 · Siguiente" walks the list as filtered (also with the arrow
 * keys and K / J), and "Volver a la lista" is always there. Corrections the
 * Secretaría asked for get a notice above
 * the workspace; the Secretaría gets a quiet line with what it still has to
 * review or publish, and what it sent back for correction (those drafts are
 * listed only under that filter). Secondary links live in the header's
 * "Más" menu. On narrow screens the two panels stack behind a toggle and
 * the amendment detail opens in a slideover.
 *
 * `?enmienda=<id>` opens that amendment (links from the home page),
 * `?transaccional=<id>,<id>` opens the transactional composer on those
 * amendments (from the presenter's review, "Transaccionar"),
 * `?enmendar=<block>` opens the amendment editor at that paragraph (from
 * the reader of an agenda item) and `?enmiendas=sin-leer` lists the
 * amendments left to read (documentLinks.ts). The open
 * amendment is kept in the address, so its link can be shared.
 *
 * The account's private notes on the document (DocumentNotes) open from
 * "Notas" in the header; the ones on the text are marked on the original
 * text, and its right-click menu offers "Añadir nota aquí".
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
    options?: { align?: "center" | "start"; focus?: boolean },
  ) => void;
  currentHeading: () => string | null;
  outline: OutlineEntry[];
  root: HTMLElement | null;
}

type TextMode = "original" | "amended" | "consolidated" | "compare";
type Pane = "text" | "amendments";
type ListTab = "all" | "mine";

interface ComposerState {
  key: number;
  mode: AmendmentComposerMode;
  /** Base block the editor opens at: where the reader was. */
  startBlockId: string | null;
  /** Text the reader had selected there, selected in the editor too. */
  startSelection: TextSpan | null;
  draftId: string | null;
  /**
   * The draft's real authors, when the viewer reads offices of the CEA
   * among them as the generic "CEA" (`loadDraftAuthors`); null otherwise.
   */
  draftAuthors: AmendmentComposerAuthorsDto | null;
}

interface TransactionalState {
  key: number;
  /** Amendments it starts from (none: the author picks them). */
  sourceIds: string[];
}

const { t } = useI18n();
const api = useApi();
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
 * "Revisar enmiendas" leads for the presenter with something pending,
 * unless a composer is open.
 */
const reviewIsPrimary = computed(
  () =>
    showReviewEntry.value &&
    isDocumentPresenter.value &&
    reviewBacklog.value.total > 0 &&
    !composing.value,
);

/** "Proponer una transaccional", in "Más" while there is something to combine. */
const showTransactEntry = computed(
  () =>
    canTransact.value &&
    !composing.value &&
    transactionalCandidates.value.length > 0,
);

/**
 * The text as a PDF: the published one, or the draft for managers
 * (canExportWorkingDraft).
 */
const canExportClean = computed(
  () =>
    isStructured.value &&
    Boolean(document.value?.can.manage || document.value?.baseVersion),
);
const cleanExport = useTemplateRef<{ start: () => Promise<void> }>(
  "cleanExport",
);

interface MoreItem {
  type?: "label";
  label: string;
  description?: string;
  icon?: string;
  to?: string;
  onSelect?: () => void;
}

/**
 * Everything but the one action of the page, in its "Más" menu: the review
 * when nothing waits there, the PDF, the record, and the less usual ways to
 * amend, each with what it does.
 */
const moreItems = computed<MoreItem[][]>(() => {
  const work: MoreItem[] = [];
  if (showReviewEntry.value && !reviewIsPrimary.value) {
    work.push({
      label: t("workspace.proponentReview.action"),
      icon: "i-lucide-list-checks",
      to: documentPath("revisar"),
    });
  }
  if (showAnswersEntry.value) {
    work.push({
      label: t("workspace.more.answers"),
      icon: "i-lucide-list-checks",
      to: documentPath("revisar"),
    });
  }
  if (showTransactEntry.value) {
    work.push({
      label: t("workspace.more.transactional"),
      icon: "i-lucide-git-merge",
      onSelect: () => startTransactional([]),
    });
  }

  const text: MoreItem[] = [];
  if (isPublished.value) {
    text.push({
      label: t("workspace.more.consolidated"),
      icon: "i-lucide-file-check",
      to: documentPath("consolidado"),
    });
  }
  if (canExportClean.value) {
    text.push({
      label: t("workspace.export.clean"),
      icon: "i-lucide-file-text",
      onSelect: () => void cleanExport.value?.start(),
    });
  }
  if (canEditRecord.value) {
    text.push({
      label: t("workspace.editRecord"),
      icon: "i-lucide-file-cog",
      to: documentPath("editar"),
    });
  }

  const ways: MoreItem[] =
    canAmend.value && isStructured.value && !composing.value
      ? [
          { type: "label", label: t("workspace.cta.otherWays") },
          ...otherWays.value,
        ]
      : [];

  return [work, text, ways].filter((group) => group.length > 0);
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

const TEXT_MODES: TextMode[] = [
  "original",
  "amended",
  "consolidated",
  "compare",
];

/** How to show the text, as visible tabs. */
const modeItems = computed(() =>
  TEXT_MODES.map((mode) => ({
    label: t(`workspace.modes.${mode}`),
    value: mode,
  })),
);

function onTextMode(mode: string | number): void {
  // Side by side takes the whole width: the detail would hide it.
  if (mode === "compare" && !compareDiff.value) detailOpen.value = false;
}

/** "Incluir las aceptadas" only changes the two views of the result. */
const showAcceptedSwitch = computed(
  () =>
    showAcceptedToggle.value &&
    (textMode.value === "consolidated" || textMode.value === "compare"),
);

/** The actor's drafts: corrections asked by the Secretaría, then unsent ones. */
const awaiting = computed(() => amendmentsAwaitingActor(list.mine.value));
const corrections = computed(() => awaiting.value.corrections);

/**
 * "Mías" counts only what waits for the actor (in warning colour when the
 * Secretaría asked for a correction).
 */
const mineWaiting = computed(
  () => corrections.value.length + awaiting.value.drafts.length,
);
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
  // so they never stretch the panel group and make it scroll on focus. Its
  // children never shrink: a long text overflows this column, and a box
  // that clips (an alert) would be squeezed and cut instead.
  body: "relative gap-4 p-4 sm:p-5 overflow-visible lg:overflow-y-auto *:shrink-0",
};

// Composers ----------------------------------------------------------------------

/**
 * The amendment composer. It takes the whole workspace: the text and the
 * list give way to it and come back as they were when it closes.
 */
const composer = ref<ComposerState | null>(null);
let composerSeq = 0;

/** The transactional composer, in the amendments panel (one composer at a time). */
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

/**
 * The last paragraph of the original text the reader rested on, inside the
 * text. On a narrow screen the text scrolls with the page: going back up to
 * the header to press "Presentar enmienda" passes over every paragraph above
 * it, so only a scroll that rests a moment (`READING_REST_MS`) counts.
 */
let lastReadBlockId: string | null = null;
const noteReadingPosition = useDebounceFn(() => {
  const root = textView.value?.root;
  if (!root || composing.value || textMode.value !== "original") return;
  if (!scrolledIntoText(root)) return;
  const known = new Set(base.value.map((block) => block.id));
  lastReadBlockId =
    blockAtReadingTop(root, (id) => known.has(id)) ?? lastReadBlockId;
}, READING_REST_MS);
useEventListener("scroll", noteReadingPosition, {
  capture: true,
  passive: true,
});

/**
 * Where the reader is in the text (`amendStartBlockId`): the first paragraph
 * of the base they have selected, else the one at the top of what they see,
 * unless they went back up to the page's header (then the last one they
 * read). Null when there is none (the editor then opens at the start).
 */
function readingBlockId(): string | null {
  const view = textView.value;
  const root = view?.root ?? null;
  const known = new Set(base.value.map((block) => block.id));
  const isBase = (id: string) => known.has(id);
  const box = workspaceBox.value;
  return amendStartBlockId({
    selected: view?.getSelectedBlockIds().find(isBase) ?? null,
    current: root ? blockAtReadingTop(root, isBase) : null,
    lastRead: lastReadBlockId,
    atHeader: Boolean(
      root &&
      box &&
      root.offsetParent !== null &&
      scrollsWithText(root, box) &&
      !scrolledIntoText(root),
    ),
  });
}

/** The transactional composer takes the amendments panel, over the original text. */
function showComposerPanel(): void {
  detailOpen.value = false;
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
  closeTransactional();
  detailOpen.value = false;
  composer.value = {
    key: (composerSeq += 1),
    mode: "document",
    startBlockId: null,
    startSelection: null,
    draftId: null,
    draftAuthors: null,
    ...options,
  };
}

/**
 * The real authors of a draft whose own name offices of the CEA only as
 * the generic "CEA": whoever edits a draft sees them one by one in the
 * composer, and only there. Null when the draft's authors are the real
 * ones already; undefined when the read was refused (said in a toast), and
 * the composer then stays closed, since saving would drop those offices.
 */
async function loadDraftAuthors(
  amendment: AmendmentDto,
): Promise<AmendmentComposerAuthorsDto | null | undefined> {
  if (!hidesExecutiveAuthors(amendment.authors)) return null;
  try {
    return await api.get<AmendmentComposerAuthorsDto>(
      `${amendmentsUrl.value}/${amendment.id}/authors`,
    );
  } catch (error) {
    api.notifyError(error, "amendment.composer.authorsFailed");
    return undefined;
  }
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

/**
 * The primary action: the whole text in an editor, where the reader was.
 * Read before the composer opens, while the text is still on screen.
 */
function startAmendment(): void {
  openComposer({ mode: "document", startBlockId: readingBlockId() });
}

// Private notes -------------------------------------------------------------------

/** The account's private notes on the document (DocumentNotes). */
const notes = useTemplateRef<{
  available: boolean;
  annotate: (blockId: string, span: TextSpan | null) => void;
}>("notes");
const notesUrl = computed(() =>
  amendmentsUrl.value.replace(/\/amendments$/, "/notes"),
);

// How long it is open, for the statistics (only once it is published).
useDocumentReading(() =>
  document.value?.status === "published"
    ? amendmentsUrl.value.replace(/\/amendments$/, "/reading")
    : null,
);

/** Their marks go on the original text only: the other views show another. */
function notesRoot(): HTMLElement | null {
  return textMode.value === "original" && !composer.value
    ? (textView.value?.root ?? null)
    : null;
}
/** "Ver en el texto": the original text, at the note's paragraph. */
function showNoteBlock(blockId: string): void {
  textMode.value = "original";
  mobilePane.value = "text";
  void nextTick(() => textView.value?.scrollToBlock(blockId, { focus: true }));
}

/** A block of the published text, the only ones an amendment acts on. */
function isBaseBlock(id: string): boolean {
  return base.value.some((block) => block.id === id);
}

/**
 * "Hacer enmienda aquí", in the menu of a right click on the text
 * (AmendmentTextActions): the editor opens there, with that text selected.
 */
function startAmendmentAt(blockId: string, span: TextSpan | null): void {
  if (!canAmend.value || composing.value) return;
  openComposer({
    mode: "document",
    startBlockId: blockId,
    startSelection: span,
  });
}

/**
 * The composer took the focus with it: it goes to the button that opens
 * one, back in the header, or else to the list.
 */
async function focusAfterComposer(): Promise<void> {
  await nextTick();
  const entry =
    globalThis.document?.querySelector<HTMLElement>("[data-amend-entry]");
  (entry ?? listHeading.value)?.focus();
}

/**
 * The amendment that takes the composer's place gets the focus, on its
 * heading. On narrow screens it opens in a slideover, which takes it itself.
 */
async function focusDetail(): Promise<void> {
  await nextTick();
  desktopDetail.value?.focusHeading();
}

function closeComposer(): void {
  composer.value = null;
  void focusAfterComposer();
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
    void focusAfterComposer();
    return;
  }
  const stored = current.draftId ? list.byId.value.get(current.draftId) : null;
  if (current.draftId && stored?.status !== "draft") {
    // Presented, withdrawn or deleted meanwhile: show it instead, if visible.
    composer.value = null;
    if (stored) {
      selectAmendment(stored.id);
      void focusDetail();
    } else {
      void focusAfterComposer();
    }
    return;
  }
  const draftAuthors = stored ? await loadDraftAuthors(stored) : null;
  // Closed, or another composer opened, while the authors were read.
  if (composer.value?.key !== key) return;
  if (draftAuthors === undefined) {
    composer.value = null;
    void focusAfterComposer();
    return;
  }
  composer.value = { ...current, draftAuthors, key: (composerSeq += 1) };
}

function onComposerSaved(amendment: AmendmentDto): void {
  list.upsert(amendment);
  if (composer.value) composer.value.draftId = amendment.id;
}

/** Sent to the Secretaría: show it among the actor's own, with its state. */
function onComposerSubmitted(amendment: AmendmentDto): void {
  list.upsert(amendment);
  composer.value = null;
  listTab.value = "mine";
  selectAmendment(amendment.id);
  void focusDetail();
}

/**
 * The other ways to amend, in the menu of one button next to the main one,
 * each with a sentence that says what it does.
 */
const OTHER_WAY_ICONS = {
  global: "i-lucide-replace-all",
  return: "i-lucide-undo-2",
  alternative: "i-lucide-file-pen-line",
} as const;

const otherWays = computed(() =>
  (["global", "return", "alternative"] as const).map((mode) => ({
    label: t(`workspace.cta.${mode}`),
    description: t(`workspace.cta.${mode}Hint`),
    icon: OTHER_WAY_ICONS[mode],
    onSelect: () => openComposer({ mode }),
  })),
);

// Amendment detail -----------------------------------------------------------------

const selectedId = ref<string | null>(null);
const detailOpen = ref(false);
const listHeading = useTemplateRef<HTMLElement>("listHeading");
/** The detail in the amendments panel (wide screens). */
const desktopDetail = useTemplateRef<{ focusHeading: () => void }>(
  "desktopDetail",
);
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
 * neighbour, or the pressed chip. A slideover returns focus by itself, unless
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
    box.querySelector<HTMLElement>(
      '[data-amendment-chip][aria-pressed="true"]',
    ) ??
    listHeading.value;
  target?.focus();
}

/**
 * Narrow screens: the amendment "Ver en el documento" was pressed on. Its
 * change takes the focus once the detail's slideover has closed, which is
 * when the slideover stops holding it.
 */
let locateAfterClose: AmendmentDto | null = null;

function onSlideoverClosed(): void {
  const located = locateAfterClose;
  locateAfterClose = null;
  if (located) {
    // The list is hidden behind the text: nothing there can take the focus.
    scrollToAmendment(located, { focus: true });
    return;
  }
  const active = globalThis.document?.activeElement;
  if (!active || active === globalThis.document.body) {
    void restoreListFocus(selectedId.value);
  }
}

/** To the amendment's first change, in the order of the text. */
function scrollToAmendment(
  amendment: AmendmentDto,
  options: { focus?: boolean } = {},
): void {
  const first = firstTouchedBlockId(amendment.ops, base.value);
  if (!first) return;
  void nextTick(() => textView.value?.scrollToBlock(first, options));
}

function selectAmendment(
  id: string,
  options: { fromText?: boolean } = {},
): void {
  selectedId.value = id;
  if (composing.value) return;
  if (!options.fromText) selectedIndex = shownIds().indexOf(id);
  detailOpen.value = true;
  // The text keeps its view: it only moves to where the amendment acts.
  const amendment = list.byId.value.get(id);
  if (amendment && !options.fromText && isDesktop.value) {
    scrollToAmendment(amendment);
  }
}

/**
 * "Ver en el documento": the amendment over the full text, scrolled to its
 * change. On narrow screens the detail closes and the text pane shows.
 */
function showInDocument(amendment: AmendmentDto): void {
  selectedId.value = amendment.id;
  textMode.value = "amended";
  if (!isDesktop.value) {
    locateAfterClose = detailOpen.value ? amendment : null;
    detailOpen.value = false;
    mobilePane.value = "text";
  }
  scrollToAmendment(amendment);
}

/** Where the open amendment sits in the list on screen, and its neighbours. */
const detailNav = computed(() =>
  amendmentNeighbours(shownIds(), selectedId.value),
);

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
 * edit in "Todas", under "Devueltas para corregir"),
 * `?transaccional=<id>,<id>` the transactional composer
 * on those amendments (the ones that can still be combined),
 * `?enmendar=<block>` the amendment editor at that paragraph, for whoever
 * may amend (asked once: it leaves the address), and `?enmiendas=sin-leer`
 * the list with only what is left to read. Client only:
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
  const amend = route.query[DOCUMENT_AMEND_QUERY];
  if (typeof amend === "string") {
    void router.replace({
      query: {
        ...route.query,
        [DOCUMENT_AMEND_QUERY]: undefined,
        [DOCUMENT_AMEND_SELECTION_QUERY]: undefined,
      },
    });
    if (canAmend.value && isStructured.value) {
      const known = isBaseBlock(amend);
      const span = known
        ? parseAmendSelection(
            amend,
            route.query[DOCUMENT_AMEND_SELECTION_QUERY],
          )
        : null;
      openComposer({
        mode: "document",
        startBlockId: known ? amend : null,
        startSelection: span && isBaseBlock(span.end.blockId) ? span : null,
      });
      return;
    }
  }
  if (route.query[DOCUMENT_AMENDMENTS_QUERY] === DOCUMENT_AMENDMENTS_UNREAD) {
    list.filters.value = applyAmendmentQuickFilter(
      list.filters.value,
      "unread",
    );
    listTab.value = "all";
    mobilePane.value = "amendments";
    // Shown for this visit, whatever the reader chose before.
    amendmentsHidden.value = false;
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

/** The draft whose authors "Editar" is reading, so a second click waits. */
let editOpening: string | null = null;
let editSeq = 0;

async function onDetailEdit(amendment: AmendmentDto): Promise<void> {
  if (editOpening === amendment.id) return;
  const seq = (editSeq += 1);
  editOpening = amendment.id;
  let draftAuthors: AmendmentComposerAuthorsDto | null | undefined;
  try {
    draftAuthors = await loadDraftAuthors(amendment);
  } finally {
    if (editSeq === seq) editOpening = null;
  }
  // While the authors were read the reader opened a composer, asked to edit
  // another draft or moved to another amendment: leave that alone.
  if (editSeq !== seq || composing.value || selectedId.value !== amendment.id) {
    return;
  }
  if (draftAuthors === undefined) return;
  openComposer({ draftId: amendment.id, draftAuthors });
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
    compareColumns.value &&
    !composing.value &&
    !detailOpen.value,
);

/**
 * "Comparar" as one text with the changes marked on it (struck and added)
 * instead of the two columns. Remembered per browser.
 */
const compareDiff = useLocalStorage<boolean>("document-compare-diff", false, {
  initOnMounted: true,
});
/** "Comparar" in its two columns, original and result. */
const compareColumns = computed(
  () => textMode.value === "compare" && !compareDiff.value,
);
/**
 * The amendments list hidden by the reader on a wide screen, so the text
 * takes the whole workspace. Remembered per browser, like the home folds.
 * Opening an amendment (a card, a mark in the text, a link) brings it back.
 * A document without amendments starts with it hidden (noAmendments).
 */
const AMENDMENTS_HIDDEN_KEY = "document-workspace-amendments-hidden";
const amendmentsHidden = ref(false);

onMounted(() => {
  // A link that asks for the list shows it.
  if (route.query[DOCUMENT_AMENDMENTS_QUERY] === DOCUMENT_AMENDMENTS_UNREAD) {
    return;
  }
  try {
    amendmentsHidden.value =
      window.localStorage.getItem(AMENDMENTS_HIDDEN_KEY) === "1";
  } catch {
    // No storage (private mode, blocked): the list starts shown.
  }
});

function setAmendmentsHidden(hidden: boolean): void {
  if (amendmentsHidden.value === hidden) return;
  amendmentsHidden.value = hidden;
  try {
    window.localStorage.setItem(AMENDMENTS_HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Not remembered; the list still hides and shows.
  }
}

/**
 * A document without amendments (once the list has loaded) starts with the
 * list hidden, whatever the reader chose elsewhere: there is nothing in it.
 * Opening it there lasts this visit only and is not remembered.
 */
// Only once mounted, like the stored choice: decided while hydrating, the
// panel would keep the server's classes (Vue does not patch them then).
const workspaceMounted = ref(false);
onMounted(() => {
  workspaceMounted.value = true;
});
const noAmendments = computed(
  () =>
    workspaceMounted.value &&
    Boolean(list.data.value) &&
    list.amendments.value.length === 0,
);
const emptyListOpened = ref(false);

/** Hiding the list closes the amendment open in it too. */
function toggleAmendments(): void {
  if (noAmendments.value) {
    emptyListOpened.value = !emptyListOpened.value;
    return;
  }
  if (amendmentsHidden.value) {
    setAmendmentsHidden(false);
    return;
  }
  detailOpen.value = false;
  setAmendmentsHidden(true);
}

watch(detailOpen, (open) => {
  if (open) setAmendmentsHidden(false);
});

/**
 * The list hidden (by the reader, or because the document has no
 * amendments), while nothing in it asks to be seen.
 */
const listHidden = computed(
  () =>
    isDesktop.value &&
    !composing.value &&
    (noAmendments.value ? !emptyListOpened.value : amendmentsHidden.value),
);
/** The text alone in the workspace: "Original y resultado", or the list hidden. */
const textOnly = computed(() => wideCompare.value || listHidden.value);
/** The hide/show button, on wide screens and outside "Original y resultado". */
const showAmendmentsToggle = computed(
  () => isDesktop.value && !wideCompare.value && !composing.value,
);

const textPanelClass = computed(() =>
  [
    mobilePane.value === "text" ? "flex" : "hidden lg:flex",
    textOnly.value ? "lg:w-full lg:not-last:border-e-0" : "",
  ].join(" "),
);
const amendmentsPanelClass = computed(() =>
  [
    mobilePane.value === "amendments" ? "flex" : "hidden lg:flex",
    textOnly.value ? "lg:hidden" : "",
  ].join(" "),
);
/**
 * Alone and wide, the text keeps the editor's measure (`main.css`), centred
 * by the body's padding, instead of running edge to edge; the two columns
 * of "Original y resultado" need the whole width. With an index the left
 * padding leaves its marks room apart from the text.
 */
const textPanelUi = computed(() => {
  const extra =
    listHidden.value && !compareColumns.value
      ? "lg:px-[max(2.75rem,calc((100%_-_52rem)/2))]"
      : textOutline.value.length > 1
        ? "lg:ps-11"
        : "";
  return { ...panelUi, body: `${panelUi.body} ${extra}`.trim() };
});
/**
 * The index in the text's left margin. With the list hidden the text sits
 * centred in a wide margin, so on large screens the index steps further away
 * from it (the margin is at least 5rem from xl and 13rem from 2xl); beside
 * the list, or on smaller screens, it keeps close.
 */
const outlineRailClass = computed(() =>
  listHidden.value && !compareColumns.value
    ? "-ms-9 xl:-ms-14 2xl:-ms-20"
    : "-ms-9",
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

/**
 * The lines in the margin of the original text, on the paragraphs undecided
 * amendments act on. On unless the reader turned them off; remembered per
 * browser.
 */
const marginMarkers = useLocalStorage<boolean>(
  "document-margin-amendments",
  true,
  { initOnMounted: true },
);
const hasMarkers = computed(() => Object.keys(list.markers.value).length > 0);
const showMarkersSwitch = computed(
  () => textMode.value === "original" && hasMarkers.value,
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
  setAmendmentsHidden(false);
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

/** The passage a transactional being written rewrites, marked in the text. */
const originalSelected = computed(() =>
  transactional.value ? transactionalPassage.value : [],
);

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
      <!-- The way back is the breadcrumb row, above -->
      <template v-if="errorStatusCode !== 404" #action>
        <UButton
          icon="i-lucide-refresh-ccw"
          :label="t('workspace.retry')"
          @click="refreshAll"
        />
      </template>
    </CommonEmptyState>

    <template v-else>
      <!-- Reading the documents one after another, and "Marcar como leído" -->
      <!-- Not while an amendment is being written: it takes the page. -->
      <DocumentReadBar v-if="!composing" :document="document" />

      <DocumentHeader
        :document="document"
        :assembly="assembly"
        :edit-to="canEditDraft ? documentPath('editar') : null"
        :show-kind="false"
        :show-reference="false"
      >
        <div class="flex flex-col items-start gap-1.5 sm:items-end">
          <div class="flex flex-wrap items-center gap-2">
            <!-- The presenter's review, only while something waits for the
                 presenter; otherwise it is in "Más". -->
            <UButton
              v-if="reviewIsPrimary"
              :to="documentPath('revisar')"
              icon="i-lucide-list-checks"
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
                  color="neutral"
                  variant="solid"
                  size="sm"
                  class="tabular-nums"
                  aria-hidden="true"
                />
              </template>
            </UButton>
            <!-- Primary, unless the presenter's review is pending. -->
            <UButton
              v-if="canAmend && isStructured && !composing"
              data-amend-entry
              icon="i-lucide-pencil-line"
              :variant="reviewIsPrimary ? 'outline' : 'solid'"
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
            <!-- The account's private notes on the document, marked on
                 the original text while it is on show. -->
            <DocumentNotes
              v-if="!composing"
              ref="notes"
              :notes-url="notesUrl"
              :blocks="base"
              :root="notesRoot"
              @locate="showNoteBlock"
            />
            <!-- The uploaded PDF in a tab of its own, on the screens
                 where it shows embedded below; elsewhere its card has the
                 button. -->
            <UButton
              v-if="document.format === 'file' && document.fileUrl"
              :to="document.fileUrl"
              external
              target="_blank"
              color="neutral"
              variant="outline"
              icon="i-lucide-external-link"
              class="max-lg:hidden"
              :label="t('workspace.text.openPdfTab')"
              data-testid="document-open-pdf"
            />
            <!-- Asked for from "Más"; it shows only once the PDF is on its
                 way, and then offers the download. -->
            <ExportButton
              v-if="canExportClean"
              ref="cleanExport"
              :assembly="assembly.id"
              :document="document.id"
              variant="clean"
              button-variant="outline"
              hide-idle
            />
            <UDropdownMenu
              v-if="moreItems.length > 0"
              :items="moreItems"
              :content="{ align: 'end' }"
              :ui="{
                content: 'w-80 max-w-[calc(100vw-2rem)]',
                item: 'items-start',
                itemLabel: 'whitespace-normal',
                itemDescription: 'whitespace-normal text-muted',
              }"
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
        v-if="document.summary && !composer"
        class="text-muted max-w-3xl text-sm whitespace-pre-line"
      >
        {{ document.summary }}
      </p>

      <!-- Uploaded PDF -->
      <DocumentPdfViewer
        v-if="document.format === 'file'"
        :url="document.fileUrl"
        :title="document.title"
        :description="
          kindAcceptsFile(document.kind)
            ? undefined
            : t('workspace.text.fileDescription')
        "
        :pending-description="t('workspace.text.filePending')"
        :open-button="false"
      />

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
        <!-- The text keeps the editor's measure (`main.css`), centred; with
             an index the left padding leaves its marks room apart. -->
        <div
          v-if="fallbackText && fallbackText.length > 0"
          class="border-default rounded-lg border p-4 sm:p-6 lg:px-[max(2.75rem,calc((100%_-_52rem)/2))]"
          :class="{ 'sm:ps-11': draftOutline.length > 1 }"
        >
          <template v-if="draftOutline.length > 1">
            <!-- Marks in the box's left margin, kept in view as the draft
                 scrolls; they take no room of their own. -->
            <div class="sticky top-4 z-20 -ms-9 h-0 max-sm:hidden">
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

        <!-- The amendment composer, in place of the text and the list -->
        <AmendmentComposer
          v-if="composer"
          :key="composer.key"
          :base="base"
          :document="document"
          :amendments-url="amendmentsUrl"
          :mode="composer.mode"
          :start-block-id="composer.startBlockId"
          :start-selection="composer.startSelection"
          :draft="composerDraft"
          :draft-authors="composer.draftAuthors"
          :others="list.listed.value"
          :label-of="list.labelOf"
          @close="closeComposer"
          @saved="onComposerSaved"
          @submitted="onComposerSubmitted"
          @conflict="refreshAll()"
          @reload="reloadComposer"
        />

        <UTabs
          v-show="!composer"
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
          v-if="textOutline.length > 1 && mobilePane === 'text' && !composer"
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
        <!-- Hidden, not removed, while the amendment composer is open: the
             text keeps its place for when it closes. -->
        <div
          v-show="!composer"
          ref="workspaceBox"
          class="border-default flex flex-col overflow-hidden rounded-lg border lg:h-[calc(100dvh-var(--shell-banner-height,0px)-var(--ui-header-height)-var(--shell-breadcrumb-height,0px)-3rem)] lg:min-h-[32rem] lg:flex-row"
        >
          <!-- Text -->
          <UDashboardPanel
            id="document-workspace-text"
            :resizable="!textOnly"
            :default-size="58"
            :min-size="35"
            :max-size="72"
            :class="textPanelClass"
            :ui="textPanelUi"
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
                  <UTabs
                    v-model="textMode"
                    :items="modeItems"
                    :content="false"
                    color="neutral"
                    size="xs"
                    class="max-w-full"
                    :ui="{
                      list: 'w-auto max-w-full overflow-x-auto',
                      trigger: 'shrink-0 grow-0',
                    }"
                    :aria-label="t('workspace.modes.label')"
                    @update:model-value="onTextMode"
                  />
                </template>
                <template
                  v-if="
                    showAcceptedSwitch ||
                    showAmendmentsToggle ||
                    showMarkersSwitch ||
                    textMode === 'compare'
                  "
                  #right
                >
                  <USwitch
                    v-if="showMarkersSwitch"
                    v-model="marginMarkers"
                    size="sm"
                    :label="t('workspace.marginMarkers')"
                    data-testid="margin-markers"
                  />
                  <USwitch
                    v-if="textMode === 'compare'"
                    v-model="compareDiff"
                    size="sm"
                    :label="t('workspace.compare.diff')"
                    data-testid="compare-diff"
                  />
                  <USwitch
                    v-if="showAcceptedSwitch"
                    v-model="includeAccepted"
                    size="sm"
                    :label="t('workspace.includeAccepted')"
                  />
                  <UButton
                    v-if="showAmendmentsToggle"
                    color="neutral"
                    variant="ghost"
                    size="sm"
                    :icon="
                      listHidden
                        ? 'i-lucide-panel-right-open'
                        : 'i-lucide-panel-right-close'
                    "
                    :label="
                      listHidden
                        ? t('workspace.panes.show')
                        : t('workspace.panes.hide')
                    "
                    :aria-expanded="!listHidden"
                    aria-controls="dashboard-panel-document-workspace-amendments"
                    data-testid="amendments-toggle"
                    @click="toggleAmendments"
                  >
                    <template v-if="listHidden" #trailing>
                      <UBadge
                        :label="String(list.listed.value.length)"
                        color="neutral"
                        variant="subtle"
                        size="sm"
                      />
                    </template>
                  </UButton>
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
                class="sticky top-2 z-20 -mb-4 h-0 max-lg:hidden"
                :class="outlineRailClass"
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
                <!-- A right click on the text offers to amend there -->
                <AmendmentTextActions
                  :amend="canAmend && isStructured && !composing"
                  :note="Boolean(notes?.available)"
                  :accept="isBaseBlock"
                  @amend="startAmendmentAt"
                  @note="(blockId, span) => notes?.annotate(blockId, span)"
                >
                  <ContentView
                    ref="textView"
                    :blocks="base"
                    :markers="marginMarkers ? list.markers.value : undefined"
                    :selected="originalSelected"
                    marker-buttons
                    @marker-click="onMarkerClick"
                  />
                </AmendmentTextActions>
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
                          class="me-1 size-4 align-middle"
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

              <!-- One text, the changes marked on it -->
              <template v-else-if="textMode === 'compare' && compareDiff">
                <p class="text-muted text-sm">
                  {{
                    finalText
                      ? t("workspace.compare.diffFinal")
                      : t("workspace.compare.diffConsolidated")
                  }}
                </p>
                <ContentView
                  ref="textView"
                  :annotated="consolidation?.annotated ?? []"
                  mode="diff"
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
              <div
                class="border-default flex flex-col gap-2 border-b px-4 py-2.5 sm:px-5"
              >
                <h2 ref="listHeading" tabindex="-1" class="sr-only">
                  {{ t("workspace.panes.amendments") }}
                </h2>
                <AmendmentFilterBar
                  v-model="list.filters.value"
                  v-model:tab="listTab"
                  :author-options="list.authorOptions.value"
                  :can-filter-mine="Boolean(member)"
                  :show-review-filter="showReviewFilter"
                  :show-returned-filter="list.returned.value.length > 0"
                  :block-label="filteredBlockLabel"
                  :show-mine="showMineTab"
                  :mine-waiting="mineWaiting"
                  :mine-urgent="corrections.length > 0"
                  :total="list.listed.value.length"
                  :unread="list.unreadIds.value.length"
                />
              </div>
            </template>

            <template #body>
              <!-- Transactional composer -->
              <TransactionalComposer
                v-if="transactional"
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
                ref="desktopDetail"
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
                :nav="detailNav"
                @close="closeDetail"
                @select="selectAmendment"
                @locate="showInDocument"
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
                      :selected="selectedId === item.id"
                      :status-of="amendmentStatusOf"
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
                  :can-transact="canTransact"
                  :status-of="amendmentStatusOf"
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
              :can-transact="canTransact"
              :nav="detailNav"
              @close="closeDetail"
              @select="selectAmendment"
              @locate="showInDocument"
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
