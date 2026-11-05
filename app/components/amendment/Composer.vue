<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AmendmentDraftBody,
  AmendmentDto,
  DocumentDto,
  MemberDto,
  MemberRef,
} from "~~/shared/types/api";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { globalReplaceOps, validateOps } from "~~/shared/utils/content/ops";
import { blockLabels } from "~~/shared/utils/content/render";
import {
  AMENDMENT_TOTALITY_MODES,
  amendmentComposerSteps,
  amendmentErrorKey,
  amendmentErrorReasons,
  amendmentLateOnSend,
  amendmentSentNotice,
  composerAuthorMemberIds,
  composerAuthorSeed,
  composerAuthorSet,
  composerMainAuthor,
  composerSyncState,
  contiguousBlockRange,
  deletePassageOps,
  passageAmendmentOps,
  passageSeed,
  seedComposerFromDraft,
  totalityAlternativeOps,
  type AmendmentComposerMode,
  type AmendmentComposerStep,
} from "~/composables/amendment/workspace";

/**
 * Guided form to present an amendment, in plain steps: what it does (the
 * choice made on the text, which can be changed here), write the change,
 * see it against the text, and explain why. Co-authors, the "formal"
 * nature and presenting on behalf of a member stay folded unless needed.
 * With co-authors, one of the members presenting it must be named main
 * author ("Autor principal"): only that one answers the transactionals
 * proposed over it, and the others see its answer.
 * Sending goes to the Secretaría, which checks it before anyone else sees
 * it. A draft sent back for correction shows the Secretaría's note on top.
 *
 * It writes an amendment as an edit of the base text and turns it into
 * operations anchored to the base:
 * - passage: edit the selected blocks in place (diffPassage);
 * - delete: suppress the selected blocks;
 * - global: replace a term everywhere (globalReplaceOps);
 * - return / alternative: totality amendments (justification only, or a
 *   full replacement text).
 * Shows a live diff preview, validates with validateOps before sending, and
 * shows the reasons of a 422. Saving creates or updates a draft; presenting
 * saves and then submits it.
 *
 * The optimistic-lock token only moves with this composer's own saves. When
 * someone else saves the draft (or a save is refused with 409), the author
 * chooses: load the stored version (`reload`, the parent remounts the
 * composer) or overwrite it with theirs after confirming.
 */
const props = withDefaults(
  defineProps<{
    base: Block[];
    document: DocumentDto;
    /** Base URL of the document's amendments: .../amendments. */
    amendmentsUrl: string;
    /** Starting mode of a new amendment. */
    mode?: AmendmentComposerMode;
    /** Selected base block ids (passage and delete modes). */
    selection?: string[];
    /** Start with an empty paragraph after the selection. */
    appendParagraph?: boolean;
    /** Draft being edited (its latest version, kept fresh by the parent). */
    draft?: AmendmentDto | null;
  }>(),
  {
    mode: "passage",
    selection: () => [],
    appendParagraph: false,
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
const formId = useId();

// State ----------------------------------------------------------------------
// Seeded once from `draft`. Later copies of it never replace the text nor the
// lock token: see the sync state below.

const seed = props.draft
  ? seedComposerFromDraft(props.base, props.draft)
  : null;

const mode = ref<AmendmentComposerMode>(seed?.mode ?? props.mode);
const selection = ref<string[]>(
  seed && seed.selection.length > 0
    ? seed.selection
    : contiguousBlockRange(props.base, props.selection),
);
const passageBlocks = ref<Block[]>(
  seed?.mode === "passage"
    ? seed.edited
    : passageSeed(
        props.base,
        selection.value,
        props.appendParagraph ? { appendEmpty: createId } : {},
      ),
);
const alternativeBlocks = ref<Block[]>(
  seed?.mode === "alternative" ? seed.edited : [],
);
const find = ref(seed?.find ?? "");
const replacement = ref(seed?.replace ?? "");
const kind = ref<"partial" | "formal">(
  props.draft?.kind === "formal" ? "formal" : "partial",
);
const justification = ref(props.draft?.justification ?? "");
/** Opened with "Añadir un párrafo después": the passage ends in a new one. */
const adding = !props.draft && props.appendParagraph;

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
 * picker holds every member presenting it, not "the others".
 */
const editingOthers = !isNew && authorSeed.keptMemberId === null;

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

const attempted = ref(false);
/** Presenting needs a justification; saving a draft does not. */
const presentAttempted = ref(false);
const serverReasons = ref<string[]>([]);

const editorRef = useTemplateRef<{ flush: () => void; focus: () => void }>(
  "editor",
);
const justificationRef = useTemplateRef<{ textareaRef?: HTMLTextAreaElement }>(
  "justificationInput",
);

// Modes ------------------------------------------------------------------------

const hasSelection = computed(() => selection.value.length > 0);

/** Ways to amend shown first; totality amendments are folded away. */
const MAIN_MODES = ["passage", "delete", "global"] as const;
const mainModeItems = computed(() =>
  MAIN_MODES.map((value) => ({
    label: t(`amendment.composer.modes.${value}`),
    description: t(`amendment.composer.modeDescriptions.${value}`),
    value,
    disabled:
      (value === "passage" || value === "delete") && !hasSelection.value,
  })),
);
const totalityModeItems = computed(() =>
  AMENDMENT_TOTALITY_MODES.map((value) => ({
    label: t(`amendment.composer.modes.${value}`),
    description: t(`amendment.composer.modeDescriptions.${value}`),
    value,
  })),
);

/** The choice list is open when there is nothing sensible chosen yet. */
const choosing = ref(
  !hasSelection.value && (mode.value === "passage" || mode.value === "delete"),
);
const advancedOpen = ref(AMENDMENT_TOTALITY_MODES.includes(mode.value));

/** The chosen main mode, or none while a totality mode is chosen. */
const mainChoice = computed(() =>
  MAIN_MODES.find((value) => value === mode.value),
);

function setMode(value: unknown): void {
  if (typeof value === "string") mode.value = value as AmendmentComposerMode;
}

const choiceLabel = computed(() =>
  adding && mode.value === "passage"
    ? t("amendment.composer.modes.add")
    : t(`amendment.composer.modes.${mode.value}`),
);

const steps = computed(() => amendmentComposerSteps(mode.value));
function stepNumber(step: AmendmentComposerStep): number {
  return steps.value.indexOf(step) + 1;
}
const stepBadge =
  "bg-primary/10 text-primary inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums";

const writeTitle = computed(() => {
  if (mode.value === "global") return t("amendment.composer.steps.writeGlobal");
  if (mode.value === "alternative") {
    return t("amendment.composer.steps.writeAlternative");
  }
  return adding
    ? t("amendment.composer.steps.writeAdd")
    : t("amendment.composer.steps.write");
});

/** The note of a draft the Secretaría sent back for correction. */
const correctionNote = computed(() =>
  props.draft?.reviewState === "correction_requested"
    ? props.draft.correctionNote
    : null,
);

const title = computed(() => {
  if (correctionNote.value) return t("amendment.composer.titleCorrection");
  return props.draft
    ? t("amendment.composer.titleEdit")
    : t("amendment.composer.titleNew");
});

watch(mode, (value) => {
  serverReasons.value = [];
  if (value === "passage" && passageBlocks.value.length === 0) {
    passageBlocks.value = passageSeed(props.base, selection.value);
  }
});

const amendmentKind = computed<AmendmentDraftBody["kind"]>(() => {
  if (mode.value === "return") return "totality_return";
  if (mode.value === "alternative") return "totality_alternative";
  return kind.value;
});

/** Only text changes can be formal (typos, style, numbering). */
const canBeFormal = computed(
  () =>
    mode.value === "passage" ||
    mode.value === "delete" ||
    mode.value === "global",
);

const passageLabel = computed(() => {
  const first = selection.value[0];
  if (!first) return null;
  const label = blockLabels(props.base).get(first);
  const parts = [
    label?.heading ?? null,
    label && label.paragraph > 0
      ? t("amendment.detail.paragraph", { n: label.paragraph })
      : null,
  ].filter(Boolean);
  return parts.join(" · ") || null;
});

// Operations -----------------------------------------------------------------

const ops = computed<AmendmentOp[]>(() => {
  switch (mode.value) {
    case "passage":
      return passageAmendmentOps(
        props.base,
        selection.value,
        passageBlocks.value,
        createId,
      );
    case "delete":
      return deletePassageOps(props.base, selection.value);
    case "global":
      return find.value.trim()
        ? globalReplaceOps(props.base, find.value.trim(), replacement.value)
        : [];
    case "alternative":
      return totalityAlternativeOps(
        props.base,
        alternativeBlocks.value,
        createId,
      );
    default:
      return [];
  }
});

const occurrences = computed(() => ({
  count: ops.value.length,
  blocks: new Set(
    ops.value.map((op) => (op.op === "replace" ? op.blockId : "")),
  ).size,
}));

/** Problems the author can fix before anything is sent. */
const localIssues = computed<string[]>(() => {
  switch (mode.value) {
    case "passage":
      if (!hasSelection.value) return ["no_selection"];
      return ops.value.length === 0 ? ["no_changes"] : [];
    case "delete":
      return hasSelection.value ? [] : ["no_selection"];
    case "global":
      if (!find.value.trim()) return ["find_empty"];
      if (find.value.trim() === replacement.value) return ["same_term"];
      return ops.value.length === 0 ? ["no_matches"] : [];
    case "alternative":
      return alternativeBlocks.value.some((block) => block.text.trim())
        ? []
        : ["alternative_empty"];
    default:
      return [];
  }
});

const opReasons = computed<string[]>(() => {
  if (mode.value === "return" || localIssues.value.length > 0) return [];
  return [...new Set(validateOps(props.base, ops.value).map((e) => e.reason))];
});

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

/** Folded options start open when the draft already uses them. */
const optionsOpen = ref(
  coAuthorIds.value.length > 0 ||
    kind.value === "formal" ||
    (canActOnBehalf.value &&
      !onBehalfRequired.value &&
      Boolean(onBehalfOfMemberId.value)),
);

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
    coAuthorIds: coAuthorIds.value,
  }),
);
const mainAuthor = computed(() =>
  composerMainAuthor(authorSet.value, mainAuthorId.value),
);
const mainAuthorBox = useTemplateRef<HTMLElement>("mainAuthorBox");

const blocked = computed(
  () =>
    localIssues.value.length > 0 ||
    opReasons.value.length > 0 ||
    needsMember.value ||
    mainAuthor.value.missing ||
    cannotPresent.value ||
    syncBlocked.value,
);
const justificationMissing = computed(() => !justification.value.trim());

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

// Members ------------------------------------------------------------------------

const { data: members, status: membersStatus } = useLazyFetch<MemberDto[]>(
  "/api/members",
  {
    key: "amendment-composer-members",
    server: false,
    default: () => [],
  },
);

const memberItems = computed(() =>
  (members.value ?? [])
    .filter((item) => item.active)
    .map((item) => ({
      label: `${item.acronym} · ${item.name}`,
      value: item.id,
    })),
);
/**
 * Everyone but the actor's member (always kept) and, on a new amendment,
 * the presenting one (always included).
 */
const coAuthorItems = computed(() => {
  const presenting = isNew ? onBehalfOfMemberId.value : undefined;
  return memberItems.value.filter(
    (item) => item.value !== member.value?.id && item.value !== presenting,
  );
});

/** Members by id, to name the main author choices. */
const memberRefs = computed(() => {
  const refs = new Map<string, Pick<MemberRef, "acronym" | "name">>();
  for (const item of members.value ?? []) refs.set(item.id, item);
  for (const author of seedAuthors) refs.set(author.id, author);
  if (member.value) refs.set(member.value.id, member.value);
  return refs;
});
const mainAuthorItems = computed(() =>
  authorSet.value.map((id) => {
    const ref = memberRefs.value.get(id);
    return {
      label: ref ? `${ref.acronym} · ${ref.name}` : id,
      value: id,
    };
  }),
);

/** Opens the folded options and takes focus to the main author choice. */
async function focusMainAuthor(): Promise<void> {
  optionsOpen.value = true;
  await nextTick();
  mainAuthorBox.value
    ?.querySelector<HTMLElement>('[role="radio"], input, button')
    ?.focus();
}

// Saving ---------------------------------------------------------------------

function handleError(error: unknown, fallbackKey: string): void {
  serverReasons.value = amendmentErrorReasons(error);
  api.notifyError(error, fallbackKey);
  if (api.isConflict(error)) emit("conflict");
}

async function persist(): Promise<AmendmentDto | null> {
  editorRef.value?.flush();
  attempted.value = true;
  serverReasons.value = [];
  if (mainAuthor.value.missing) void focusMainAuthor();
  if (blocked.value) return null;

  const body: AmendmentDraftBody = {
    kind: amendmentKind.value,
    ops: ops.value,
    justification: justification.value.trim(),
    // A co-author editing someone else's draft stays among its authors.
    authorMemberIds: composerAuthorMemberIds(
      coAuthorIds.value,
      authorSeed.keptMemberId,
    ),
    mainAuthorMemberId: mainAuthor.value.value,
    globalReplace:
      mode.value === "global"
        ? { find: find.value.trim(), replace: replacement.value }
        : null,
    ...(onBehalfOfMemberId.value
      ? { onBehalfOfMemberId: onBehalfOfMemberId.value }
      : {}),
  };

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
  presentAttempted.value = true;
  editorRef.value?.flush();
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

onMounted(() => {
  if (mode.value === "passage" || mode.value === "alternative") {
    nextTick(() => editorRef.value?.focus());
  }
});
</script>

<template>
  <form
    :id="formId"
    class="flex flex-col gap-6"
    novalidate
    :aria-label="title"
    @submit.prevent="present"
  >
    <header class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <h2 class="text-highlighted text-lg font-semibold">{{ title }}</h2>
        <p class="text-muted text-sm">{{ document.title }}</p>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-label="t('amendment.composer.close')"
        @click="emit('close')"
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
      v-if="cannotPresent"
      color="error"
      variant="subtle"
      icon="i-lucide-user-x"
      :title="t('amendment.composer.noMember')"
      :description="t('amendment.composer.noMemberDescription')"
    />

    <!-- Step: what the amendment does -->
    <section class="flex flex-col gap-2" :aria-labelledby="`${formId}-what`">
      <h3
        :id="`${formId}-what`"
        class="text-highlighted flex items-center gap-2 text-sm font-semibold"
      >
        <span :class="stepBadge" aria-hidden="true">
          {{ stepNumber("what") }}
        </span>
        <span class="sr-only">
          {{ t("amendment.composer.step", { n: stepNumber("what") }) }}
        </span>
        {{ t("amendment.composer.steps.what") }}
      </h3>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p class="text-default text-sm font-medium">
          {{ choiceLabel }}
          <span
            v-if="passageLabel && (mode === 'passage' || mode === 'delete')"
            class="text-muted font-normal"
          >
            · {{ passageLabel }}
          </span>
        </p>
        <UButton
          color="primary"
          variant="link"
          size="sm"
          class="px-0"
          :aria-expanded="choosing"
          :aria-controls="`${formId}-choices`"
          :label="
            choosing
              ? t('amendment.composer.hideChoices')
              : t('amendment.composer.changeChoice')
          "
          @click="choosing = !choosing"
        />
      </div>
      <p class="text-muted text-sm">
        {{ t(`amendment.composer.modeDescriptions.${mode}`) }}
      </p>

      <div
        v-if="choosing"
        :id="`${formId}-choices`"
        class="flex flex-col gap-3 pt-1"
      >
        <URadioGroup
          :model-value="mainChoice"
          :items="mainModeItems"
          variant="card"
          size="sm"
          :aria-labelledby="`${formId}-what`"
          @update:model-value="setMode"
        />
        <p v-if="!hasSelection" class="text-muted text-xs">
          {{ t("amendment.composer.selectFirst") }}
        </p>
        <UCollapsible v-model:open="advancedOpen">
          <UButton
            color="neutral"
            variant="link"
            size="sm"
            class="px-0"
            :icon="
              advancedOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
            "
            :label="t('amendment.composer.advanced')"
          />
          <template #content>
            <URadioGroup
              class="mt-2"
              :model-value="mode"
              :items="totalityModeItems"
              :legend="t('amendment.composer.totalityLegend')"
              variant="card"
              size="sm"
              @update:model-value="setMode"
            />
          </template>
        </UCollapsible>
      </div>

      <UAlert
        v-if="mode === 'return'"
        color="neutral"
        variant="subtle"
        icon="i-lucide-file-x"
        :description="t('amendment.composer.returnNote')"
      />
    </section>

    <!-- Step: write the change -->
    <section
      v-if="steps.includes('write')"
      class="flex flex-col gap-2"
      :aria-labelledby="`${formId}-write`"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3
          :id="`${formId}-write`"
          class="text-highlighted flex items-center gap-2 text-sm font-semibold"
        >
          <span :class="stepBadge" aria-hidden="true">
            {{ stepNumber("write") }}
          </span>
          <span class="sr-only">
            {{ t("amendment.composer.step", { n: stepNumber("write") }) }}
          </span>
          {{ writeTitle }}
        </h3>
        <UButton
          v-if="mode === 'alternative'"
          icon="i-lucide-copy"
          color="neutral"
          variant="outline"
          size="xs"
          :label="t('amendment.composer.copyOriginal')"
          @click="copyOriginal"
        />
      </div>

      <!-- Passage: edit in place -->
      <template v-if="mode === 'passage'">
        <ClientOnly>
          <ContentBlockEditor
            ref="editor"
            v-model="passageBlocks"
            compact
            :label="t('amendment.composer.editorLabel')"
            :placeholder="t('amendment.composer.editorPlaceholder')"
          />
          <template #fallback>
            <USkeleton class="h-32 w-full" />
          </template>
        </ClientOnly>
        <p class="text-dimmed text-xs">
          {{
            adding
              ? t("amendment.composer.addHint")
              : t("amendment.composer.editorHint")
          }}
        </p>
      </template>

      <!-- Global replacement -->
      <template v-else-if="mode === 'global'">
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
      </template>

      <!-- Totality: alternative text -->
      <template v-else-if="mode === 'alternative'">
        <p class="text-muted text-sm">
          {{ t("amendment.composer.alternativeHint") }}
        </p>
        <ClientOnly>
          <ContentBlockEditor
            ref="editor"
            v-model="alternativeBlocks"
            :label="t('amendment.composer.alternativeLabel')"
            :placeholder="t('amendment.composer.alternativePlaceholder')"
          />
          <template #fallback>
            <USkeleton class="h-48 w-full" />
          </template>
        </ClientOnly>
      </template>
    </section>

    <!-- Step: see the change -->
    <section
      v-if="steps.includes('check')"
      class="flex flex-col gap-2"
      :aria-labelledby="`${formId}-check`"
      aria-live="polite"
    >
      <h3
        :id="`${formId}-check`"
        class="text-highlighted flex items-center gap-2 text-sm font-semibold"
      >
        <span :class="stepBadge" aria-hidden="true">
          {{ stepNumber("check") }}
        </span>
        <span class="sr-only">
          {{ t("amendment.composer.step", { n: stepNumber("check") }) }}
        </span>
        {{ t("amendment.composer.steps.check") }}
      </h3>
      <p v-if="mode === 'delete'" class="text-muted text-sm">
        {{ t("amendment.composer.deleteHint") }}
      </p>
      <div class="border-default rounded-md border p-3 sm:p-4">
        <ContentAmendmentDiff
          v-if="localIssues.length === 0 && ops.length > 0"
          :id="`${formId}-preview`"
          :base="base"
          :ops="ops"
          :context="1"
        />
        <p v-else class="text-muted text-sm">
          {{ t(`amendment.composer.issues.${localIssues[0] ?? "no_changes"}`) }}
        </p>
      </div>
    </section>

    <UAlert
      v-if="opReasons.length > 0 || serverReasons.length > 0"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      role="alert"
      :title="t('amendment.composer.errorsTitle')"
    >
      <template #description>
        <ul class="list-disc ps-5">
          <li
            v-for="reason in [...new Set([...opReasons, ...serverReasons])]"
            :key="reason"
          >
            {{ t(amendmentErrorKey(reason)) }}
          </li>
        </ul>
      </template>
    </UAlert>

    <!-- A moderator's account that presents nothing of its own must pick the member. -->
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
        :search-input="{ placeholder: t('amendment.composer.memberSearch') }"
        clear
      />
    </UFormField>

    <!-- Step: why -->
    <UFormField
      required
      :error="
        presentAttempted && justificationMissing
          ? t('amendment.composer.justificationRequired')
          : undefined
      "
      :help="t('amendment.composer.justificationHelp')"
    >
      <template #label>
        <span
          class="text-highlighted flex items-center gap-2 text-sm font-semibold"
        >
          <span :class="stepBadge" aria-hidden="true">
            {{ stepNumber("why") }}
          </span>
          <span class="sr-only">
            {{ t("amendment.composer.step", { n: stepNumber("why") }) }}
          </span>
          {{ t("amendment.composer.steps.why") }}
        </span>
      </template>
      <UTextarea
        ref="justificationInput"
        v-model="justification"
        :rows="4"
        autoresize
        :maxrows="14"
        class="w-full"
        :maxlength="20000"
        :placeholder="t('amendment.composer.justificationPlaceholder')"
      />
    </UFormField>

    <!-- Only if needed: co-authors, formal amendment, on behalf of a member. -->
    <UCollapsible v-model:open="optionsOpen">
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        class="px-0"
        :icon="optionsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :label="t('amendment.composer.moreOptions')"
      />
      <template #content>
        <div
          class="border-default mt-2 flex flex-col gap-4 rounded-md border p-3 sm:p-4"
        >
          <UFormField
            :label="
              editingOthers
                ? t('amendment.detail.authors')
                : t('amendment.composer.coAuthors')
            "
            :help="t('amendment.composer.coAuthorsHint')"
          >
            <USelectMenu
              v-model="coAuthorIds"
              :items="coAuthorItems"
              value-key="value"
              multiple
              class="w-full"
              :loading="membersStatus === 'pending'"
              :placeholder="t('amendment.composer.coAuthorsPlaceholder')"
              :search-input="{
                placeholder: t('amendment.composer.memberSearch'),
              }"
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

          <UCheckbox
            v-if="canBeFormal"
            :model-value="kind === 'formal'"
            :label="t('amendment.composer.formal')"
            :description="t('amendment.composer.formalDescription')"
            @update:model-value="kind = $event === true ? 'formal' : 'partial'"
          />

          <UFormField
            v-if="canActOnBehalf && !onBehalfRequired"
            :label="t('amendment.composer.onBehalf')"
            :help="t('amendment.composer.onBehalfHint')"
          >
            <USelectMenu
              v-model="onBehalfOfMemberId"
              :items="memberItems"
              value-key="value"
              class="w-full"
              :loading="membersStatus === 'pending'"
              :placeholder="t('amendment.composer.onBehalfPlaceholder')"
              :search-input="{
                placeholder: t('amendment.composer.memberSearch'),
              }"
              clear
            />
          </UFormField>
        </div>
      </template>
    </UCollapsible>

    <footer
      class="border-default bg-default sticky bottom-0 -mx-1 flex flex-col gap-2 border-t px-1 pt-3 pb-1"
    >
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
              @click="emit('close')"
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

      <p class="text-muted flex items-start gap-1.5 text-xs">
        <UIcon
          name="i-lucide-shield-check"
          class="mt-px size-3.5 shrink-0"
          aria-hidden="true"
        />
        {{ t("amendment.composer.reviewNotice") }}
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('amendment.actions.cancel')"
          :disabled="busy !== null"
          @click="emit('close')"
        />
        <UButton
          class="ms-auto"
          icon="i-lucide-save"
          color="neutral"
          variant="outline"
          :loading="busy === 'save'"
          :disabled="busy !== null || cannotPresent || syncBlocked"
          :label="t('amendment.composer.saveDraft')"
          @click="saveDraft"
        />
        <UButton
          type="submit"
          icon="i-lucide-send"
          :loading="busy === 'submit'"
          :disabled="busy !== null || cannotPresent || syncBlocked"
          :label="t('amendment.composer.submit')"
        />
      </div>
    </footer>
  </form>
</template>
