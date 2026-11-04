<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type {
  AmendmentDraftBody,
  AmendmentDto,
  DocumentDto,
  MemberDto,
} from "~~/shared/types/api";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { globalReplaceOps, validateOps } from "~~/shared/utils/content/ops";
import { blockLabels } from "~~/shared/utils/content/render";
import {
  amendmentErrorKey,
  amendmentErrorReasons,
  contiguousBlockRange,
  deletePassageOps,
  passageAmendmentOps,
  passageSeed,
  seedComposerFromDraft,
  totalityAlternativeOps,
  type AmendmentComposerMode,
} from "~/composables/amendment/workspace";

/**
 * Writes an amendment as an edit of the base text and turns it into
 * operations anchored to the base:
 * - passage: edit the selected blocks in place (diffPassage);
 * - delete: suppress the selected blocks;
 * - global: replace a term everywhere (globalReplaceOps);
 * - return / alternative: totality amendments (justification only, or a
 *   full replacement text).
 * Shows a live diff preview, validates with validateOps before sending, and
 * shows the reasons of a 422. Saving creates or updates a draft; presenting
 * saves and then submits it.
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
  conflict: [];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const { member } = useMe();
const formId = useId();

// State ----------------------------------------------------------------------
// Seeded once: later changes of `draft` only refresh its updatedAt.

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

const draftId = ref<string | null>(props.draft?.id ?? null);
const updatedAt = ref<string | null>(props.draft?.updatedAt ?? null);

const canActOnBehalf = computed(() => props.document.can.moderate);
const onBehalfOfMemberId = ref<string | undefined>(undefined);
const coAuthorIds = ref<string[]>([]);

(function seedAuthors(): void {
  const authors = props.draft?.authors ?? [];
  const own = member.value?.id;
  if (own && authors.some((author) => author.id === own)) {
    coAuthorIds.value = authors
      .filter((author) => author.id !== own)
      .map((author) => author.id);
  } else if (authors.length > 0 && canActOnBehalf.value) {
    onBehalfOfMemberId.value = authors[0]!.id;
    coAuthorIds.value = authors.slice(1).map((author) => author.id);
  } else {
    coAuthorIds.value = authors
      .filter((author) => author.id !== own)
      .map((author) => author.id);
  }
})();

watch(
  () => props.draft?.updatedAt,
  (value) => {
    if (value && props.draft?.id === draftId.value) updatedAt.value = value;
  },
);

const busy = ref<"save" | "submit" | null>(null);
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

const modeItems = computed(() =>
  (["passage", "delete", "global", "return", "alternative"] as const).map(
    (value) => ({
      label: t(`amendment.composer.modes.${value}`),
      value,
      disabled:
        (value === "passage" || value === "delete") && !hasSelection.value,
    }),
  ),
);

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

const kindItems = computed(() =>
  (["partial", "formal"] as const).map((value) => ({
    label: t(`amendment.kinds.${value}`),
    description: t(`amendment.composer.kindDescriptions.${value}`),
    value,
  })),
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

const needsMember = computed(
  () => !member.value && !onBehalfOfMemberId.value && canActOnBehalf.value,
);
const cannotPresent = computed(() => !member.value && !canActOnBehalf.value);

const blocked = computed(
  () =>
    localIssues.value.length > 0 ||
    opReasons.value.length > 0 ||
    needsMember.value ||
    cannotPresent.value,
);
const justificationMissing = computed(() => !justification.value.trim());

const windowClosed = computed(() => {
  const closesAt = toDate(props.document.window.closesAt);
  return Boolean(closesAt && closesAt.getTime() <= Date.now());
});

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
const coAuthorItems = computed(() =>
  memberItems.value.filter(
    (item) =>
      item.value !== member.value?.id &&
      item.value !== onBehalfOfMemberId.value,
  ),
);

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
  if (blocked.value) return null;

  const body: AmendmentDraftBody = {
    kind: amendmentKind.value,
    ops: ops.value,
    justification: justification.value.trim(),
    authorMemberIds: coAuthorIds.value,
    globalReplace:
      mode.value === "global"
        ? { find: find.value.trim(), replace: replacement.value }
        : null,
    ...(onBehalfOfMemberId.value
      ? { onBehalfOfMemberId: onBehalfOfMemberId.value }
      : {}),
  };

  try {
    const saved =
      draftId.value && updatedAt.value
        ? await api.send<AmendmentDto>(
            `${props.amendmentsUrl}/${draftId.value}`,
            { method: "PUT", body: { ...body, updatedAt: updatedAt.value } },
          )
        : await api.send<AmendmentDto>(props.amendmentsUrl, { body });
    draftId.value = saved.id;
    updatedAt.value = saved.updatedAt;
    emit("saved", saved);
    return saved;
  } catch (error) {
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
    toast.add({
      title: t("amendment.composer.submitted"),
      description: submitted.late
        ? t("amendment.composer.submittedLate")
        : undefined,
      color: submitted.late ? "warning" : "success",
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
    class="flex flex-col gap-5"
    novalidate
    :aria-label="
      draft
        ? t('amendment.composer.titleEdit')
        : t('amendment.composer.titleNew')
    "
    @submit.prevent="present"
  >
    <header class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <h2 class="text-highlighted text-lg font-semibold">
          {{
            draft
              ? t("amendment.composer.titleEdit")
              : t("amendment.composer.titleNew")
          }}
        </h2>
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

    <UAlert
      v-if="windowClosed"
      color="warning"
      variant="subtle"
      icon="i-lucide-clock-alert"
      :title="t('amendment.composer.lateTitle')"
      :description="t('amendment.composer.lateWarning')"
    />
    <UAlert
      v-if="cannotPresent"
      color="error"
      variant="subtle"
      icon="i-lucide-user-x"
      :title="t('amendment.composer.noMember')"
      :description="t('amendment.composer.noMemberDescription')"
    />

    <UFormField :label="t('amendment.composer.mode')">
      <USelect v-model="mode" :items="modeItems" class="w-full" />
      <template #help>
        {{ t(`amendment.composer.modeDescriptions.${mode}`) }}
      </template>
    </UFormField>

    <!-- Passage: edit in place -->
    <section v-if="mode === 'passage'" class="flex flex-col gap-2">
      <p class="text-muted flex flex-wrap items-center gap-1.5 text-sm">
        <UIcon name="i-lucide-pilcrow" class="size-4" aria-hidden="true" />
        {{
          t(
            "amendment.composer.passageCount",
            { count: selection.length },
            selection.length,
          )
        }}
        <span v-if="passageLabel" class="text-default"
          >· {{ passageLabel }}</span
        >
      </p>
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
        {{ t("amendment.composer.editorHint") }}
      </p>
    </section>

    <!-- Delete -->
    <section v-else-if="mode === 'delete'" class="flex flex-col gap-2">
      <p class="text-muted flex flex-wrap items-center gap-1.5 text-sm">
        <UIcon name="i-lucide-pilcrow" class="size-4" aria-hidden="true" />
        {{
          t(
            "amendment.composer.passageCount",
            { count: selection.length },
            selection.length,
          )
        }}
        <span v-if="passageLabel" class="text-default"
          >· {{ passageLabel }}</span
        >
      </p>
      <p class="text-sm">{{ t("amendment.composer.deleteHint") }}</p>
    </section>

    <!-- Global replacement -->
    <section v-else-if="mode === 'global'" class="flex flex-col gap-3">
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
    </section>

    <!-- Totality: return -->
    <UAlert
      v-else-if="mode === 'return'"
      color="neutral"
      variant="subtle"
      icon="i-lucide-file-x"
      :title="t('amendment.kinds.totality_return')"
      :description="t('amendment.composer.returnNote')"
    />

    <!-- Totality: alternative text -->
    <section v-else class="flex flex-col gap-2">
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
          <USkeleton class="h-48 w-full" />
        </template>
      </ClientOnly>
    </section>

    <!-- Preview -->
    <section
      v-if="mode !== 'return'"
      class="flex flex-col gap-2"
      aria-live="polite"
    >
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("amendment.composer.preview") }}
      </h3>
      <div class="border-default rounded-md border p-3 sm:p-4">
        <ContentAmendmentDiff
          v-if="localIssues.length === 0 && ops.length > 0"
          id="composer-preview"
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

    <URadioGroup
      v-if="mode === 'passage' || mode === 'delete' || mode === 'global'"
      v-model="kind"
      :items="kindItems"
      :legend="t('amendment.composer.kind')"
      size="sm"
    />

    <UFormField
      :label="t('amendment.composer.justification')"
      required
      :error="
        presentAttempted && justificationMissing
          ? t('amendment.composer.justificationRequired')
          : undefined
      "
    >
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

    <UFormField
      v-if="canActOnBehalf"
      :label="t('amendment.composer.onBehalf')"
      :help="t('amendment.composer.onBehalfHint')"
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

    <UFormField
      :label="t('amendment.composer.coAuthors')"
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
        :search-input="{ placeholder: t('amendment.composer.memberSearch') }"
      />
    </UFormField>

    <footer
      class="border-default bg-default sticky bottom-0 -mx-1 flex flex-wrap items-center gap-2 border-t px-1 pt-3 pb-1"
    >
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
        :disabled="busy !== null || cannotPresent"
        :label="t('amendment.composer.saveDraft')"
        @click="saveDraft"
      />
      <UButton
        type="submit"
        icon="i-lucide-send"
        :loading="busy === 'submit'"
        :disabled="busy !== null || cannotPresent"
        :label="t('amendment.composer.submit')"
      />
    </footer>
  </form>
</template>
