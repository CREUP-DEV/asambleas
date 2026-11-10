<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type { Editor } from "@tiptap/core";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AmendmentDraftBody,
  AmendmentDto,
  DocumentDto,
  MemberDto,
  MemberRef,
} from "~~/shared/types/api";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { blocksToEditor, editorToBlocks } from "~~/shared/utils/content/editor";
import {
  globalReplaceOps,
  touchedBlockIds,
  validateOps,
} from "~~/shared/utils/content/ops";
import {
  amendmentErrorKey,
  amendmentErrorReasons,
  amendmentLateOnSend,
  amendmentSentNotice,
  changedBlockCount,
  composerAmendmentKind,
  composerAuthorMemberIds,
  composerAuthorSeed,
  composerAuthorSet,
  composerDocumentSeed,
  composerStartBlockId,
  composerEditSettler,
  composerIssues,
  composerMainAuthor,
  composerSyncState,
  documentAmendmentOps,
  seedComposerFromDraft,
  totalityAlternativeOps,
  type AmendmentComposerMode,
} from "~/composables/amendment/workspace";

/**
 * Presents an amendment. It takes the place of the text and the list (the
 * whole width; the whole screen on a phone) and has two parts:
 *
 * - on the left, the whole published text in an editor, opened where the
 *   reader was (`startBlockId`). The author edits it like any text: nobody
 *   says whether a change modifies, adds or suppresses, the difference with
 *   the base does (`documentAmendmentOps`, formatting included). Everything
 *   changed in one go is one amendment with one justification;
 * - on the right (below on a phone), a panel that stays in view with three
 *   questions: what kind of amendment it is (content or form, nothing chosen
 *   for a new one), who presents it (alone or with other members, and then
 *   who the main author is) and why. Under them, how many paragraphs change
 *   and "Revisar y enviar".
 *
 * "Revisar y enviar" shows the changes as everybody else will see them, what
 * is still missing in plain words, the late notices, and "Guardar borrador"
 * and "Enviar". Sending goes to the Secretaría, which checks it before anyone
 * else sees it. A draft sent back for correction shows the Secretaría's note
 * on top.
 *
 * Three other ways to amend open here from their links in the page, with
 * their own form in place of the editor: one word changed everywhere
 * (`global`, globalReplaceOps) and the totality amendments (`return`, only a
 * justification; `alternative`, a full replacement text).
 *
 * A stored draft opens with the text as it leaves it (its operations
 * applied), so the author goes on editing; saving diffs it against the base
 * again.
 *
 * The difference is worked out a moment after the author stops typing, never
 * on each keystroke: a long text would stutter.
 *
 * The optimistic-lock token only moves with this composer's own saves. When
 * someone else saves the draft (or a save is refused with 409), the author
 * chooses: load the stored version (`reload`, the parent remounts the
 * composer) or overwrite it with theirs after confirming.
 *
 * Leaving with changes that were not saved asks first.
 */
const props = withDefaults(
  defineProps<{
    base: Block[];
    document: DocumentDto;
    /** Base URL of the document's amendments: .../amendments. */
    amendmentsUrl: string;
    /** What a new amendment writes. */
    mode?: AmendmentComposerMode;
    /** Base block the editor opens at: where the reader was. */
    startBlockId?: string | null;
    /** Draft being edited (its latest version, kept fresh by the parent). */
    draft?: AmendmentDto | null;
  }>(),
  {
    mode: "document",
    startBlockId: null,
    draft: null,
  },
);

const emit = defineEmits<{
  close: [];
  saved: [amendment: AmendmentDto];
  submitted: [amendment: AmendmentDto];
  /** A save was refused: the parent refetches the list. */
  conflict: [];
  /** Load the stored version: the parent refetches and remounts the composer. */
  reload: [];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const { member, can } = useMe();
const uid = useId();
const isDesktop = useMediaQuery("(min-width: 1024px)");

// State ----------------------------------------------------------------------
// Seeded once from `draft`. Later copies of it never replace the text nor the
// lock token: see the sync state below.

const seed = props.draft
  ? seedComposerFromDraft(props.base, props.draft)
  : null;

/** Fixed for the life of the composer: each way to amend opens its own. */
const mode: AmendmentComposerMode = seed?.mode ?? props.mode;

/** The untouched text as the editor gives it back, to tell real changes. */
function editorEcho(blocks: Block[]): Block[] {
  try {
    return editorToBlocks(blocksToEditor(blocks), createId);
  } catch {
    return [];
  }
}

const documentSeed: Block[] =
  mode === "document" ? (seed?.edited ?? composerDocumentSeed(props.base)) : [];
const settle = composerEditSettler(
  documentSeed,
  mode === "document" ? editorEcho(documentSeed) : [],
);

/** The whole text as the author has it in the editor. */
const edited = shallowRef<Block[]>(documentSeed);
const alternativeBlocks = shallowRef<Block[]>(
  seed?.mode === "alternative" ? seed.edited : [],
);
const find = ref(seed?.find ?? "");
const replacement = ref(seed?.replace ?? "");
/** Content or form: the author chooses; a stored draft keeps its own. */
const kind = ref<"partial" | "formal" | null>(
  props.draft?.kind === "formal" || props.draft?.kind === "partial"
    ? props.draft.kind
    : null,
);
const justification = ref(props.draft?.justification ?? "");

const draftId = ref<string | null>(props.draft?.id ?? null);
const updatedAt = ref<string | null>(props.draft?.updatedAt ?? null);

const canActOnBehalf = computed(() => props.document.can.moderate);
/** A new amendment: no stored draft when the composer opened. */
const isNew = !props.draft;
const seedAuthors = props.draft?.authors ?? [];
const authorSeed = composerAuthorSeed(
  seedAuthors.map((author) => author.id),
  member.value?.id ?? null,
  props.draft?.mainAuthorId ?? null,
);
/**
 * Picked by a moderator only. A stored draft keeps its presenting member
 * unless the moderator picks another one: nothing is sent on its behalf.
 */
const onBehalfOfMemberId = ref<string | undefined>(
  authorSeed.onBehalfOfMemberId,
);
const coAuthorIds = ref<string[]>(authorSeed.coAuthorIds);
const mainAuthorId = ref<string | undefined>(
  authorSeed.mainAuthorId ?? undefined,
);
/**
 * Editing a draft the actor's member does not present (a moderator): the
 * picker holds every member presenting it, not "the others", and there is
 * no "alone or with others" to choose.
 */
const editingOthers = !isNew && authorSeed.keptMemberId === null;
/** "Con otros miembros": the picker shows and its members count. */
const withOthers = ref(coAuthorIds.value.length > 0);
/**
 * The generic "CEA" stands for executive areas this account does not see.
 * When the draft has it, it stays: only the CEA or the Secretaría take an
 * area out (the server keeps them whatever is sent).
 */
const genericCoAuthorKept = authorSeed.coAuthorIds.some(
  isGenericExecutiveMember,
);
watch(coAuthorIds, (ids) => {
  if (genericCoAuthorKept && !ids.some(isGenericExecutiveMember)) {
    coAuthorIds.value = [
      ...ids,
      ...keptGenericExecutive(authorSeed.coAuthorIds),
    ];
  }
});
const sentCoAuthorIds = computed(() =>
  editingOthers || withOthers.value
    ? coAuthorIds.value
    : keptGenericExecutive(coAuthorIds.value),
);

// Operations -----------------------------------------------------------------
// Worked out a moment after the last change (`scheduleOps`), and right away
// before reviewing, saving or leaving (`refreshOps`).

interface EditorHandle {
  flush: () => void;
  focus: () => void;
  editor?: Editor;
}
const editorRef = useTemplateRef<EditorHandle>("editor");

/**
 * Ids for blocks the difference has to renew, handed out in the same order
 * each time: the same text gives the same operations, so an unchanged text
 * never looks changed.
 */
const idPool: string[] = [];
function pooledIds(): () => string {
  let next = 0;
  return () => {
    idPool[next] ??= createId();
    next += 1;
    return idPool[next - 1]!;
  };
}

function computeOps(): AmendmentOp[] {
  switch (mode) {
    case "document":
      return documentAmendmentOps(
        props.base,
        settle(edited.value),
        pooledIds(),
      );
    case "global":
      return find.value.trim()
        ? globalReplaceOps(props.base, find.value.trim(), replacement.value)
        : [];
    case "alternative":
      return totalityAlternativeOps(
        props.base,
        alternativeBlocks.value,
        pooledIds(),
      );
    default:
      return [];
  }
}

const ops = shallowRef<AmendmentOp[]>(computeOps());

function refreshOps(): void {
  editorRef.value?.flush();
  ops.value = computeOps();
}

// A long text waits longer, so typing never stutters.
const scheduleOps = useDebounceFn(
  () => {
    ops.value = computeOps();
  },
  props.base.length > 150 ? 600 : 200,
);

const serverReasons = ref<string[]>([]);
watch([edited, alternativeBlocks, find, replacement], () => {
  serverReasons.value = [];
  void scheduleOps();
});

const occurrences = computed(() => ({
  count: ops.value.length,
  blocks: new Set(touchedBlockIds(ops.value)).size,
}));
const changedCount = computed(() => changedBlockCount(ops.value));

/** Whether the question "content or form" applies (never to a totality). */
const asksKind = mode === "document" || mode === "global";

/** What the author still has to do before anything is saved. */
const issues = computed(() =>
  composerIssues({
    mode,
    kind: kind.value,
    ops: ops.value,
    find: find.value,
    replacement: replacement.value,
    alternative: alternativeBlocks.value,
  }),
);
/** The ones about the text itself: with any, there is nothing to show. */
const textIssues = computed(() =>
  issues.value.filter((issue) => issue !== "kind_missing"),
);

const opReasons = computed<string[]>(() => {
  if (mode === "return" || textIssues.value.length > 0) return [];
  return [...new Set(validateOps(props.base, ops.value).map((e) => e.reason))];
});

// Sync with the stored draft ---------------------------------------------------

const busy = ref<"save" | "submit" | null>(null);
/** A save was refused (409, or 404 when it is gone or hidden now). */
const conflicted = ref(false);
const confirmingOverwrite = ref(false);
const reloading = ref(false);

const syncState = computed(() =>
  composerSyncState({
    draftId: draftId.value,
    token: updatedAt.value,
    remote: props.draft,
    conflicted: conflicted.value,
    documentOpen:
      props.document.status === "published" &&
      props.document.amendable &&
      !props.document.finalVote,
  }),
);

watch(syncState, (state) => {
  if (state !== "remote_newer") confirmingOverwrite.value = false;
});

function loadRemote(): void {
  reloading.value = true;
  // The author chose the stored version over theirs: nothing to ask.
  finished = true;
  emit("reload");
}

/** Keeps this version: takes the stored token, then saves over it. */
async function overwrite(): Promise<void> {
  const remote = props.draft;
  if (!remote || remote.id !== draftId.value) return;
  updatedAt.value = remote.updatedAt;
  conflicted.value = false;
  confirmingOverwrite.value = false;
  await saveDraft();
}

// Presenting moves the draft on (status and token): not a conflict. During a
// plain save the live list can deliver this save's own token before the
// response does, so a brief "remote newer" is not someone else's change.
// overwrite() adopts the remote token first, so nothing real is hidden.
const showSync = computed(
  () =>
    syncState.value !== "in_sync" &&
    busy.value !== "submit" &&
    !(busy.value === "save" && !conflicted.value),
);

const syncDescription = computed(() => {
  switch (syncState.value) {
    case "remote_newer":
      return conflicted.value
        ? t("amendment.composer.sync.remote_newer.refused")
        : t("amendment.composer.sync.remote_newer.description");
    case "conflict":
      return t("amendment.composer.sync.conflict.description");
    case "not_editable":
      return t("amendment.composer.sync.not_editable.description");
    default:
      return undefined;
  }
});

// Titles and notices -------------------------------------------------------------

/** The note of a draft the Secretaría sent back for correction. */
const correctionNote = computed(() =>
  props.draft?.reviewState === "correction_requested"
    ? props.draft.correctionNote
    : null,
);

const title = computed(() => {
  if (correctionNote.value) return t("amendment.composer.titleCorrection");
  if (props.draft) return t("amendment.composer.titleEdit");
  return mode === "document"
    ? t("amendment.composer.titleNew")
    : t(`amendment.composer.modes.${mode}`);
});
const intro = computed(() =>
  mode === "document"
    ? t("amendment.composer.intro")
    : t(`amendment.composer.modeDescriptions.${mode}`),
);

// The shared clock ticks every minute, so a window that closes while the
// page is open is seen as closed, and hydration matches the server.
const now = useAppNow();
const windowClosed = computed(() => {
  const closesAt = toDate(props.document.window.closesAt);
  return Boolean(closesAt && closesAt.getTime() <= now.value);
});
/**
 * Sending now makes it late. A correction keeps the timing of its first
 * presentation (as the server does), whatever the window says today.
 */
const lateOnSend = computed(() =>
  amendmentLateOnSend(props.draft, windowClosed.value),
);
const isCorrection = computed(
  () => props.draft?.reviewState === "correction_requested",
);
/** A correction that arrived late the first time and is still late. */
const lateKept = computed(() => isCorrection.value && lateOnSend.value);
/** A correction that arrived on time stays on time, deadline or not. */
const onTimeKept = computed(
  () => isCorrection.value && windowClosed.value && !lateOnSend.value,
);

// Who presents it ------------------------------------------------------------------

/**
 * A moderator presents on behalf of a member when their account has none, or
 * when it cannot present amendments of its own (no amendment:create). Only a
 * new amendment needs it: a stored draft keeps its presenting member.
 */
const onBehalfRequired = computed(
  () =>
    canActOnBehalf.value &&
    isNew &&
    (!member.value || !can(PERMISSION_KEYS.AMENDMENT_CREATE)),
);
const needsMember = computed(
  () => onBehalfRequired.value && !onBehalfOfMemberId.value,
);
const cannotPresent = computed(() => !member.value && !canActOnBehalf.value);
const syncBlocked = computed(() => syncState.value !== "in_sync");
/** The Mesa's own control, small and out of the way until it is used. */
const onBehalfOpen = ref(Boolean(onBehalfOfMemberId.value));

/**
 * Everyone presenting it: the presenting member of a new amendment (picked
 * on behalf, or the actor's own), the kept own member of a stored draft,
 * and the co-authors. With several, one must be the main author.
 */
const authorSet = computed(() =>
  composerAuthorSet({
    presentingMemberId: isNew
      ? (onBehalfOfMemberId.value ?? member.value?.id ?? null)
      : (onBehalfOfMemberId.value ?? null),
    keptMemberId: authorSeed.keptMemberId,
    coAuthorIds: sentCoAuthorIds.value,
  }),
);
const mainAuthor = computed(() =>
  composerMainAuthor(authorSet.value, mainAuthorId.value),
);
const mainAuthorBox = useTemplateRef<HTMLElement>("mainAuthorBox");

const { data: members, status: membersStatus } = useLazyFetch<MemberDto[]>(
  "/api/members",
  {
    key: "amendment-composer-members",
    server: false,
    default: () => [],
  },
);

/** Never the generic "CEA": it is not a member anyone can add. */
const memberItems = computed(() =>
  addableMembers(members.value ?? [])
    .filter((item) => item.active)
    .map((item) => ({
      label: memberLabel(item),
      value: item.id,
      disabled: false,
    })),
);
/**
 * Everyone but the actor's member (always kept) and, on a new amendment,
 * the presenting one (always included). A generic "CEA" the draft already
 * has is listed so it is named, but cannot be taken out.
 */
const coAuthorItems = computed(() => {
  const presenting = isNew ? onBehalfOfMemberId.value : undefined;
  const items = memberItems.value.filter(
    (item) => item.value !== member.value?.id && item.value !== presenting,
  );
  const kept = keptGenericExecutive(coAuthorIds.value).map((id) => ({
    label: memberName(id),
    value: id,
    disabled: true,
  }));
  return [...kept, ...items];
});

/** Members by id, to name them. */
const memberRefs = computed(() => {
  const refs = new Map<string, Pick<MemberRef, "acronym" | "name">>();
  for (const item of members.value ?? []) refs.set(item.id, item);
  for (const author of seedAuthors) refs.set(author.id, author);
  if (member.value) refs.set(member.value.id, member.value);
  return refs;
});
function memberName(id: string): string {
  const ref = memberRefs.value.get(id);
  return ref ? memberLabel(ref) : id;
}
const mainAuthorItems = computed(() =>
  authorSet.value.map((id) => ({ label: memberName(id), value: id })),
);

/** The member that presents it alone: the one picked on behalf, or the actor's. */
const soloMemberId = computed(
  () =>
    onBehalfOfMemberId.value ??
    (isNew ? member.value?.id : authorSeed.keptMemberId) ??
    null,
);
const whoItems = computed(() => {
  const solo = soloMemberId.value
    ? memberRefs.value.get(soloMemberId.value)
    : undefined;
  return [
    {
      label: solo
        ? t("amendment.composer.who.solo", { member: solo.acronym })
        : t("amendment.composer.who.soloUnknown"),
      value: "solo",
    },
    {
      label: t("amendment.composer.who.others"),
      description: t("amendment.composer.who.othersHint"),
      value: "others",
    },
  ];
});
function setWho(value: unknown): void {
  withOthers.value = value === "others";
}

const kindItems = computed(() =>
  (["partial", "formal"] as const).map((value) => ({
    label: t(`amendment.composer.kind.${value}`),
    description: t(`amendment.composer.kind.${value}Hint`),
    value,
  })),
);
function setKind(value: unknown): void {
  if (value === "partial" || value === "formal") kind.value = value;
}

/** Takes focus to the main author choice. */
async function focusMainAuthor(): Promise<void> {
  await nextTick();
  mainAuthorBox.value
    ?.querySelector<HTMLElement>('[role="radio"], input, button')
    ?.focus();
}

// Review -------------------------------------------------------------------------

const stage = ref<"edit" | "review">("edit");
/** "Revisar y enviar" was pressed: what is missing is said from then on. */
const attempted = ref(false);
const heading = useTemplateRef<HTMLElement>("heading");
const reviewHeading = useTemplateRef<HTMLElement>("reviewHeading");
const justificationRef = useTemplateRef<{ textareaRef?: HTMLTextAreaElement }>(
  "justificationInput",
);

const blocked = computed(
  () =>
    issues.value.length > 0 ||
    opReasons.value.length > 0 ||
    needsMember.value ||
    mainAuthor.value.missing ||
    cannotPresent.value ||
    syncBlocked.value,
);
const justificationMissing = computed(() => !justification.value.trim());

/** What stops the amendment from being saved, in plain words. */
const problems = computed<string[]>(() => {
  const list = issues.value.map((issue) =>
    t(`amendment.composer.issues.${issue}`),
  );
  for (const reason of new Set([...opReasons.value, ...serverReasons.value])) {
    list.push(t(amendmentErrorKey(reason)));
  }
  if (needsMember.value) list.push(t("amendment.composer.onBehalfRequired"));
  if (mainAuthor.value.missing) {
    list.push(t("amendment.composer.mainAuthorRequired"));
  }
  return list;
});

/** Who presents it, by name, the main author marked when there are several. */
const authorNames = computed(() =>
  authorSet.value
    .map((id) =>
      mainAuthor.value.required && mainAuthor.value.value === id
        ? t("amendment.composer.review.mainMark", { member: memberName(id) })
        : memberName(id),
    )
    .join(", "),
);

const kindLabel = computed(() => {
  if (!asksKind) return t(`amendment.composer.modes.${mode}`);
  return kind.value ? t(`amendment.composer.kind.${kind.value}`) : null;
});

async function openReview(): Promise<void> {
  refreshOps();
  attempted.value = true;
  stage.value = "review";
  await nextTick();
  reviewHeading.value?.focus();
}

async function backToEdit(): Promise<void> {
  stage.value = "edit";
  await nextTick();
  heading.value?.focus();
}

// Saving ---------------------------------------------------------------------

function draftBody(): Omit<AmendmentDraftBody, "kind"> & {
  kind: AmendmentDraftBody["kind"] | null;
} {
  return {
    kind: composerAmendmentKind(mode, kind.value),
    ops: ops.value,
    justification: justification.value.trim(),
    // A co-author editing someone else's draft stays among its authors.
    authorMemberIds: composerAuthorMemberIds(
      sentCoAuthorIds.value,
      authorSeed.keptMemberId,
    ),
    mainAuthorMemberId: mainAuthor.value.value,
    globalReplace:
      mode === "global"
        ? { find: find.value.trim(), replace: replacement.value }
        : null,
    ...(onBehalfOfMemberId.value
      ? { onBehalfOfMemberId: onBehalfOfMemberId.value }
      : {}),
  };
}

// Unsaved changes: what would be saved now against what was saved last.
let savedSnapshot = JSON.stringify(draftBody());
/** Sent, or given up for the stored version: nothing left to ask about. */
let finished = false;

function hasUnsavedChanges(): boolean {
  if (finished) return false;
  refreshOps();
  return JSON.stringify(draftBody()) !== savedSnapshot;
}

function handleError(error: unknown, fallbackKey: string): void {
  serverReasons.value = amendmentErrorReasons(error);
  api.notifyError(error, fallbackKey);
  if (api.isConflict(error)) emit("conflict");
}

async function persist(): Promise<AmendmentDto | null> {
  refreshOps();
  attempted.value = true;
  serverReasons.value = [];
  if (mainAuthor.value.missing) void focusMainAuthor();
  const body = draftBody();
  if (blocked.value || body.kind === null) return null;

  const updating = Boolean(draftId.value && updatedAt.value);
  try {
    const saved = updating
      ? await api.send<AmendmentDto>(
          `${props.amendmentsUrl}/${draftId.value}`,
          { method: "PUT", body: { ...body, updatedAt: updatedAt.value } },
        )
      : await api.send<AmendmentDto>(props.amendmentsUrl, { body });
    draftId.value = saved.id;
    updatedAt.value = saved.updatedAt;
    conflicted.value = false;
    savedSnapshot = JSON.stringify(body);
    emit("saved", saved);
    return saved;
  } catch (error) {
    const status = api.errorStatus(error);
    if (updating && (status === 409 || status === 404)) {
      // Someone saved first, or the draft changed state or disappeared.
      // Keep this text and the old token: the author decides what to do.
      conflicted.value = true;
      emit("conflict");
      return null;
    }
    handleError(error, "amendment.composer.saveFailed");
    return null;
  }
}

async function saveDraft(): Promise<void> {
  busy.value = "save";
  try {
    const saved = await persist();
    if (saved) {
      toast.add({
        title: t("amendment.composer.saved"),
        color: "success",
        icon: "i-lucide-save",
      });
    }
  } finally {
    busy.value = null;
  }
}

async function present(): Promise<void> {
  attempted.value = true;
  if (justificationMissing.value) {
    justificationRef.value?.textareaRef?.focus();
    return;
  }
  busy.value = "submit";
  try {
    const saved = await persist();
    if (!saved) return;
    // A failed submit keeps the draft id, so trying again does not create
    // a second draft.
    const submitted = await api.send<AmendmentDto>(
      `${props.amendmentsUrl}/${saved.id}/submit`,
    );
    const notice = amendmentSentNotice(submitted);
    toast.add({
      title:
        notice === "public"
          ? t("amendment.detail.presented")
          : t("amendment.composer.submitted"),
      description: t(
        notice === "public"
          ? "amendment.detail.presentedDescription"
          : notice === "review_late"
            ? "amendment.composer.submittedLate"
            : "amendment.composer.submittedDescription",
      ),
      color: notice === "review_late" ? "warning" : "success",
      icon: "i-lucide-send",
    });
    finished = true;
    emit("submitted", submitted);
  } catch (error) {
    handleError(error, "amendment.composer.submitFailed");
  } finally {
    busy.value = null;
  }
}

function copyOriginal(): void {
  alternativeBlocks.value = props.base.map((block) => ({
    ...block,
    marks: block.marks.map((mark) => ({ ...mark })),
  }));
}

// Leaving ------------------------------------------------------------------------

const leaveOpen = ref(false);

function requestClose(): void {
  if (busy.value !== null) return;
  if (hasUnsavedChanges()) {
    leaveOpen.value = true;
    return;
  }
  emit("close");
}

function discardAndClose(): void {
  leaveOpen.value = false;
  finished = true;
  emit("close");
}

onBeforeRouteLeave(() => {
  if (!hasUnsavedChanges()) return true;
  return window.confirm(t("amendment.composer.leave.confirm"));
});

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = "";
}

// Where the reader was -----------------------------------------------------------

const root = useTemplateRef<HTMLElement>("root");
const scroller = useTemplateRef<HTMLElement>("scroller");
/** Room the editor's toolbar takes at the top of the text while it scrolls. */
const TOOLBAR_ROOM = 72;

/** A new amendment opens where the reader was; a draft, at its first change. */
const startId =
  mode === "document"
    ? (props.startBlockId ??
      (props.draft
        ? composerStartBlockId(props.base, props.draft.ops, documentSeed)
        : null))
    : null;
let placed = false;

/** Brings that block to the top of the editor, with the cursor in it. */
function placeEditor(instance: Editor): void {
  const box = scroller.value;
  if (!startId || !box) return;
  const element = instance.view.dom.querySelector<HTMLElement>(
    `[data-block-id="${CSS.escape(startId)}"]`,
  );
  if (!element) return;
  // Typing on a phone opens the keyboard: there the text only scrolls, and
  // the focus stays on the heading (onMounted).
  if (isDesktop.value) {
    try {
      const position = instance.view.posAtDOM(element, 0);
      instance
        .chain()
        .setTextSelection(position)
        .focus(undefined, { scrollIntoView: false })
        .run();
    } catch {
      // The block takes no cursor (an image): scrolling to it is enough.
    }
  }
  box.scrollTop +=
    element.getBoundingClientRect().top -
    box.getBoundingClientRect().top -
    TOOLBAR_ROOM;
}

watch(
  () => editorRef.value?.editor,
  (instance) => {
    if (!instance || placed || mode !== "document") return;
    placed = true;
    void nextTick(() => placeEditor(instance));
  },
  { flush: "post" },
);

onMounted(() => {
  window.addEventListener("beforeunload", onBeforeUnload);
  // The composer is as tall as the hub's scroll area: bring all of it in.
  root.value?.scrollIntoView({ block: isDesktop.value ? "nearest" : "start" });
  // The button that opened the composer is gone: the heading takes the
  // focus, so the keyboard and screen readers start here. On a wide screen
  // the editor takes it next, at the starting block (placeEditor).
  heading.value?.focus({ preventScroll: true });
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
});

const questionClass = "text-highlighted text-sm font-semibold";
</script>

<template>
  <section
    ref="root"
    class="border-default flex flex-col gap-3 rounded-lg border p-3 sm:p-4 lg:h-[calc(100dvh-var(--ui-header-height)-var(--shell-breadcrumb-height,0px)-3rem)] lg:min-h-[38rem]"
    :aria-labelledby="`${uid}-title`"
  >
    <header class="flex flex-wrap items-start gap-2">
      <div class="min-w-0 flex-1 basis-64">
        <h2
          :id="`${uid}-title`"
          ref="heading"
          tabindex="-1"
          class="text-highlighted text-lg font-semibold focus:outline-none"
        >
          {{ title }}
        </h2>
        <p class="text-muted text-sm">{{ intro }}</p>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="outline"
        size="sm"
        :disabled="busy !== null"
        :label="t('amendment.composer.close')"
        @click="requestClose"
      />
    </header>

    <!-- What the Secretaría asked to fix. -->
    <UAlert
      v-if="correctionNote"
      color="warning"
      variant="subtle"
      icon="i-lucide-message-square-warning"
      :title="t('amendment.composer.correctionTitle')"
    >
      <template #description>
        <span class="block whitespace-pre-line">{{ correctionNote }}</span>
      </template>
    </UAlert>

    <UAlert
      v-if="cannotPresent"
      color="error"
      variant="subtle"
      icon="i-lucide-user-x"
      :title="t('amendment.composer.noMember')"
      :description="t('amendment.composer.noMemberDescription')"
    />

    <!-- The stored draft moved on: the author chooses, nothing is adopted silently. -->
    <UAlert
      v-if="showSync"
      :color="syncState === 'not_editable' ? 'error' : 'warning'"
      variant="subtle"
      :icon="
        syncState === 'not_editable' ? 'i-lucide-file-lock' : 'i-lucide-users'
      "
      role="alert"
      :title="t(`amendment.composer.sync.${syncState}.title`)"
      :description="syncDescription"
    >
      <template #actions>
        <div
          v-if="confirmingOverwrite"
          class="flex flex-wrap items-center gap-2"
          role="group"
        >
          <span class="text-sm">
            {{ t("amendment.composer.sync.overwriteConfirm") }}
          </span>
          <UButton
            color="error"
            size="sm"
            :loading="busy === 'save'"
            :disabled="busy !== null"
            :label="t('amendment.composer.sync.overwrite')"
            @click="overwrite"
          />
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :disabled="busy !== null"
            :label="t('common.cancel')"
            @click="confirmingOverwrite = false"
          />
        </div>
        <div v-else class="flex flex-wrap items-center gap-2">
          <UButton
            v-if="syncState === 'not_editable'"
            color="neutral"
            variant="outline"
            size="sm"
            :label="t('common.close')"
            @click="discardAndClose"
          />
          <template v-else>
            <UButton
              color="warning"
              size="sm"
              icon="i-lucide-refresh-ccw"
              :loading="reloading"
              :disabled="busy !== null || reloading"
              :label="t('document.authoring.loadRemote')"
              @click="loadRemote"
            />
            <UButton
              v-if="syncState === 'remote_newer'"
              color="neutral"
              variant="outline"
              size="sm"
              :disabled="busy !== null || reloading"
              :label="t('amendment.composer.sync.keepMine')"
              @click="confirmingOverwrite = true"
            />
          </template>
        </div>
      </template>
    </UAlert>

    <div
      class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[minmax(0,1fr)]"
    >
      <!-- Writing: kept mounted while reviewing, so the editor keeps its
           cursor and its undo history. -->
      <div
        v-show="stage === 'edit'"
        ref="scroller"
        class="min-h-0 min-w-0 overflow-y-auto p-0.5 lg:h-full"
        :class="
          mode === 'document' || mode === 'alternative'
            ? 'max-lg:h-[70dvh]'
            : ''
        "
      >
        <!-- The whole text, edited in place -->
        <ClientOnly v-if="mode === 'document'">
          <ContentBlockEditor
            ref="editor"
            v-model="edited"
            amend
            outline
            :label="t('amendment.composer.editorLabel')"
            :placeholder="t('amendment.composer.editorPlaceholder')"
          />
          <template #fallback>
            <USkeleton aria-hidden="true" class="h-96 w-full" />
          </template>
        </ClientOnly>

        <!-- One word everywhere -->
        <div v-else-if="mode === 'global'" class="flex flex-col gap-3">
          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField :label="t('amendment.composer.find')" required>
              <UInput
                v-model="find"
                class="w-full"
                :maxlength="500"
                autocomplete="off"
                :placeholder="t('amendment.composer.findPlaceholder')"
              />
            </UFormField>
            <UFormField :label="t('amendment.composer.replace')">
              <UInput
                v-model="replacement"
                class="w-full"
                :maxlength="500"
                autocomplete="off"
                :placeholder="t('amendment.composer.replacePlaceholder')"
              />
            </UFormField>
          </div>
          <p class="text-sm" aria-live="polite">
            <template v-if="find.trim()">
              {{
                t(
                  "amendment.composer.occurrences",
                  { count: occurrences.count, blocks: occurrences.blocks },
                  occurrences.count,
                )
              }}
            </template>
            <span v-else class="text-muted">
              {{ t("amendment.composer.globalHint") }}
            </span>
          </p>
        </div>

        <!-- Totality: send the document back -->
        <UAlert
          v-else-if="mode === 'return'"
          color="neutral"
          variant="subtle"
          icon="i-lucide-file-x"
          :description="t('amendment.composer.returnNote')"
        />

        <!-- Totality: alternative text -->
        <div v-else class="flex flex-col gap-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="text-muted text-sm">
              {{ t("amendment.composer.alternativeHint") }}
            </p>
            <UButton
              icon="i-lucide-copy"
              color="neutral"
              variant="outline"
              size="xs"
              :label="t('amendment.composer.copyOriginal')"
              @click="copyOriginal"
            />
          </div>
          <ClientOnly>
            <ContentBlockEditor
              ref="editor"
              v-model="alternativeBlocks"
              :label="t('amendment.composer.alternativeLabel')"
              :placeholder="t('amendment.composer.alternativePlaceholder')"
            />
            <template #fallback>
              <USkeleton aria-hidden="true" class="h-48 w-full" />
            </template>
          </ClientOnly>
        </div>
      </div>

      <!-- Reviewing: the amendment as everybody else will see it -->
      <div
        v-if="stage === 'review'"
        class="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto p-0.5 lg:h-full"
        :aria-labelledby="`${uid}-review`"
        role="region"
      >
        <div>
          <h3
            :id="`${uid}-review`"
            ref="reviewHeading"
            tabindex="-1"
            class="text-highlighted text-base font-semibold focus:outline-none"
          >
            {{ t("amendment.composer.review.title") }}
          </h3>
          <p class="text-muted text-sm">
            {{ t("amendment.composer.review.description") }}
          </p>
        </div>

        <UAlert
          v-if="lateKept"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock-alert"
          :title="t('amendment.composer.lateKeptTitle')"
          :description="t('amendment.composer.lateKeptWarning')"
        />
        <UAlert
          v-else-if="lateOnSend"
          color="warning"
          variant="subtle"
          icon="i-lucide-clock-alert"
          :title="t('amendment.composer.lateTitle')"
          :description="t('amendment.composer.lateWarning')"
        />
        <p
          v-else-if="onTimeKept"
          class="text-muted flex items-start gap-1.5 text-sm"
        >
          <UIcon
            name="i-lucide-clock-check"
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t("amendment.composer.correctionOnTime") }}
        </p>

        <UAlert
          v-if="problems.length > 0"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          role="alert"
          :title="t('amendment.composer.review.problems')"
        >
          <template #description>
            <ul class="list-disc ps-5">
              <li v-for="problem in problems" :key="problem">{{ problem }}</li>
            </ul>
          </template>
        </UAlert>

        <dl
          class="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)]"
        >
          <dt class="text-muted">{{ t("amendment.composer.review.kind") }}</dt>
          <dd class="text-default">
            {{ kindLabel ?? t("amendment.composer.review.noKind") }}
          </dd>
          <dt class="text-muted">{{ t("amendment.composer.review.who") }}</dt>
          <dd class="text-default">
            {{ authorNames || t("amendment.composer.review.noWho") }}
          </dd>
          <dt class="text-muted">{{ t("amendment.composer.review.why") }}</dt>
          <dd class="text-default whitespace-pre-line">
            {{
              justificationMissing
                ? t("amendment.composer.review.noWhy")
                : justification.trim()
            }}
          </dd>
        </dl>

        <div v-if="mode !== 'return'" class="flex flex-col gap-2">
          <h4 class="text-highlighted text-sm font-semibold">
            {{ t("amendment.composer.review.changes") }}
          </h4>
          <div class="border-default rounded-md border p-3 sm:p-4">
            <ContentAmendmentDiff
              v-if="
                textIssues.length === 0 &&
                opReasons.length === 0 &&
                ops.length > 0
              "
              :id="`${uid}-preview`"
              :base="base"
              :ops="ops"
              :context="1"
            />
            <p v-else class="text-muted text-sm">
              {{
                t(`amendment.composer.issues.${textIssues[0] ?? "no_changes"}`)
              }}
            </p>
          </div>
        </div>
        <UAlert
          v-else
          color="neutral"
          variant="subtle"
          icon="i-lucide-file-x"
          :description="t('amendment.composer.returnNote')"
        />

        <div
          class="border-default bg-default sticky bottom-0 mt-auto flex flex-col gap-2 border-t pt-3"
        >
          <p class="text-muted flex items-start gap-1.5 text-xs">
            <UIcon
              name="i-lucide-shield-check"
              class="mt-px size-3.5 shrink-0"
              aria-hidden="true"
            />
            {{ t("amendment.composer.reviewNotice") }}
          </p>
          <p
            v-if="justificationMissing && !blocked"
            class="text-default text-sm"
          >
            {{ t("amendment.composer.justificationRequired") }}
          </p>
          <div class="flex flex-wrap items-center gap-2">
            <UButton
              icon="i-lucide-arrow-left"
              color="neutral"
              variant="ghost"
              :disabled="busy !== null"
              :label="t('amendment.composer.review.back')"
              @click="backToEdit"
            />
            <UButton
              class="ms-auto"
              icon="i-lucide-save"
              color="neutral"
              variant="outline"
              :loading="busy === 'save'"
              :disabled="busy !== null || blocked"
              :label="t('amendment.composer.saveDraft')"
              @click="saveDraft"
            />
            <UButton
              icon="i-lucide-send"
              :loading="busy === 'submit'"
              :disabled="busy !== null || blocked"
              :label="t('amendment.composer.submit')"
              @click="present"
            />
          </div>
        </div>
      </div>

      <!-- The three questions, always in view -->
      <aside
        class="border-default flex min-h-0 min-w-0 flex-col rounded-md border lg:h-full"
        :aria-label="t('amendment.composer.panelLabel')"
      >
        <div
          class="flex min-h-0 flex-1 flex-col gap-5 p-3 sm:p-4 lg:overflow-y-auto"
        >
          <!-- 1. Content or form -->
          <div v-if="asksKind" class="flex flex-col gap-1.5">
            <URadioGroup
              :model-value="kind ?? undefined"
              :items="kindItems"
              :legend="t('amendment.composer.kind.question')"
              :ui="{ legend: `${questionClass} mb-2` }"
              variant="card"
              size="sm"
              aria-required="true"
              @update:model-value="setKind"
            />
            <p
              v-if="attempted && kind === null"
              role="alert"
              class="text-error text-sm"
            >
              {{ t("amendment.composer.issues.kind_missing") }}
            </p>
          </div>

          <!-- 2. Who presents it -->
          <div class="flex flex-col gap-3">
            <!-- A moderator's account that presents nothing of its own must
                 pick the member. -->
            <UFormField
              v-if="canActOnBehalf && onBehalfRequired"
              :label="t('amendment.composer.onBehalf')"
              required
              :help="
                member
                  ? t('amendment.composer.onBehalfOnlyHint')
                  : t('amendment.composer.onBehalfHint')
              "
              :error="
                attempted && needsMember
                  ? t('amendment.composer.onBehalfRequired')
                  : undefined
              "
            >
              <USelectMenu
                v-model="onBehalfOfMemberId"
                :items="memberItems"
                value-key="value"
                class="w-full"
                :loading="membersStatus === 'pending'"
                :placeholder="t('amendment.composer.onBehalfPlaceholder')"
                :aria-label="
                  selectMenuLabel(
                    t('amendment.composer.onBehalf'),
                    memberItems,
                    onBehalfOfMemberId,
                    t('amendment.composer.onBehalfPlaceholder'),
                  )
                "
                :search-input="
                  labelledSearch(t('amendment.composer.memberSearch'))
                "
                clear
              />
            </UFormField>

            <URadioGroup
              v-if="!editingOthers"
              :model-value="withOthers ? 'others' : 'solo'"
              :items="whoItems"
              :legend="t('amendment.composer.who.question')"
              :ui="{ legend: `${questionClass} mb-2` }"
              variant="card"
              size="sm"
              @update:model-value="setWho"
            />
            <p v-else :class="questionClass">
              {{ t("amendment.composer.who.question") }}
            </p>

            <UFormField
              v-if="editingOthers || withOthers"
              :label="
                editingOthers
                  ? t('amendment.detail.authors')
                  : t('amendment.composer.who.members')
              "
              :help="
                genericCoAuthorKept
                  ? t('amendment.composer.who.ceaKept')
                  : undefined
              "
            >
              <USelectMenu
                v-model="coAuthorIds"
                :items="coAuthorItems"
                value-key="value"
                multiple
                class="w-full"
                :loading="membersStatus === 'pending'"
                :placeholder="t('amendment.composer.who.placeholder')"
                :aria-label="
                  selectMenuLabel(
                    editingOthers
                      ? t('amendment.detail.authors')
                      : t('amendment.composer.who.members'),
                    coAuthorItems,
                    coAuthorIds,
                    t('amendment.composer.who.placeholder'),
                  )
                "
                :search-input="
                  labelledSearch(t('amendment.composer.memberSearch'))
                "
              />
            </UFormField>

            <!-- Several members present it: one answers the transactionals. -->
            <div v-if="mainAuthor.required" ref="mainAuthorBox">
              <UFormField
                :label="t('amendment.composer.mainAuthor')"
                required
                :help="t('amendment.composer.mainAuthorHint')"
                :error="
                  attempted && mainAuthor.missing
                    ? t('amendment.composer.mainAuthorRequired')
                    : undefined
                "
              >
                <!-- The visible label is the field's; the legend names the group. -->
                <URadioGroup
                  v-model="mainAuthorId"
                  :items="mainAuthorItems"
                  :legend="t('amendment.composer.mainAuthor')"
                  :ui="{ legend: 'sr-only' }"
                  aria-required="true"
                  size="sm"
                />
              </UFormField>
            </div>

            <!-- The Mesa records an amendment dictated in the room. -->
            <template v-if="canActOnBehalf && !onBehalfRequired">
              <UButton
                v-if="!onBehalfOpen"
                color="neutral"
                variant="link"
                size="xs"
                class="self-start px-0"
                icon="i-lucide-user-round-pen"
                :label="t('amendment.composer.who.onBehalfToggle')"
                @click="onBehalfOpen = true"
              />
              <UFormField
                v-else
                size="sm"
                :label="t('amendment.composer.onBehalf')"
                :help="t('amendment.composer.onBehalfHint')"
              >
                <USelectMenu
                  v-model="onBehalfOfMemberId"
                  :items="memberItems"
                  value-key="value"
                  size="sm"
                  class="w-full"
                  :loading="membersStatus === 'pending'"
                  :placeholder="t('amendment.composer.onBehalfPlaceholder')"
                  :aria-label="
                    selectMenuLabel(
                      t('amendment.composer.onBehalf'),
                      memberItems,
                      onBehalfOfMemberId,
                      t('amendment.composer.onBehalfPlaceholder'),
                    )
                  "
                  :search-input="
                    labelledSearch(t('amendment.composer.memberSearch'))
                  "
                  clear
                />
              </UFormField>
            </template>
          </div>

          <!-- 3. Why -->
          <UFormField
            required
            :error="
              attempted && justificationMissing
                ? t('amendment.composer.justificationRequired')
                : undefined
            "
            :help="t('amendment.composer.why.help')"
          >
            <template #label>
              <span :class="questionClass">
                {{ t("amendment.composer.why.question") }}
              </span>
            </template>
            <UTextarea
              ref="justificationInput"
              v-model="justification"
              :rows="4"
              autoresize
              :maxrows="12"
              class="w-full"
              :maxlength="20000"
              :placeholder="t('amendment.composer.justificationPlaceholder')"
            />
          </UFormField>
        </div>

        <!-- 4. How much changes, and on to the review -->
        <div
          v-if="stage === 'edit'"
          class="border-default flex shrink-0 flex-col gap-2 border-t p-3 sm:p-4"
        >
          <p
            v-if="mode === 'document'"
            class="text-default flex items-center gap-1.5 text-sm font-medium"
            aria-live="polite"
          >
            <UIcon
              name="i-lucide-pencil-line"
              class="size-4 shrink-0"
              aria-hidden="true"
            />
            {{
              t(
                "amendment.composer.changed",
                { count: changedCount },
                changedCount,
              )
            }}
          </p>
          <UButton
            block
            icon="i-lucide-list-checks"
            :disabled="cannotPresent"
            :label="t('amendment.composer.review.action')"
            @click="openReview"
          />
        </div>
      </aside>
    </div>

    <!-- Leaving with changes that were not saved -->
    <UModal
      v-model:open="leaveOpen"
      :title="t('amendment.composer.leave.title')"
      :description="t('amendment.composer.leave.description')"
    >
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('amendment.composer.leave.discard')"
            @click="discardAndClose"
          />
          <UButton
            :label="t('amendment.composer.leave.stay')"
            @click="leaveOpen = false"
          />
        </div>
      </template>
    </UModal>
  </section>
</template>
