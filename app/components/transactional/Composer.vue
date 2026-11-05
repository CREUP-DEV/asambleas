<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type {
  AmendmentDto,
  DocumentDto,
  MemberRef,
  TransactionalBody,
} from "~~/shared/types/api";
import type { Block } from "~~/shared/types/content";
import { diffPassage } from "~~/shared/utils/content/diff";
import { touchedBlockIds, validateOps } from "~~/shared/utils/content/ops";
import { blockLabels } from "~~/shared/utils/content/render";
import {
  amendmentErrorKey,
  amendmentErrorReasons,
  composerMainAuthor,
} from "~/composables/amendment/workspace";
import { useTransactionalProgressText } from "~/composables/amendment/useTransactionalProgressText";
import {
  transactionalAuthorsToAsk,
  transactionalComposerSeed,
  transactionalMemberList,
  transactionalNextSteps,
  transactionalSameBlocks,
  transactionalSameIds,
  transactionalSourceBlockers,
  transactionalSourceCandidates,
  transactionalSourceEligible,
  transactionalSourceLimit,
  transactionalSourcesInOrder,
  type TransactionalComposerSeed,
  type TransactionalNextStep,
} from "~/composables/amendment/transactional";

/**
 * "Proponer una transaccional" in the document workspace, for any member
 * who can amend and for the Mesa. In plain steps: which published,
 * undecided amendments it combines, the text (seeded with the passage they
 * touch and the amendments applied, edited in place), the change against
 * the original, and why. Sending (POST .../amendments/transactional, submit
 * true) explains what happens next from where the server left it: the main
 * author of each amendment it combines accepts or rejects it (a rejection
 * closes it), the Secretaría checks and publishes it, and then it replaces
 * those amendments and follows the normal flow (the document's main
 * presenter answers it; it is voted or incorporated). The Mesa's is public
 * at once and replaces them as soon as their main authors accept it. When
 * the Mesa names several proposers, one must be the main author.
 *
 * What was typed is never dropped silently: changing the amendments,
 * resetting the text, closing or leaving the page ask first.
 *
 * The send button stays enabled while something is missing: pressing it
 * says what (no amendment chosen, too many, the text unchanged, no
 * justification, nobody presenting it) and takes focus there. It is only
 * disabled while there is nothing to combine (the empty state says so) or
 * a chosen amendment can no longer be combined (an alert says so).
 */
const props = withDefaults(
  defineProps<{
    base: Block[];
    document: DocumentDto;
    /** Base URL of the document's amendments: .../amendments. */
    amendmentsUrl: string;
    /** The amendments the viewer sees, drafts left out. */
    amendments: AmendmentDto[];
    labelOf: (id: string) => string;
    /** Amendments to start from (an overlap group, one amendment), or none. */
    initialSourceIds?: string[];
  }>(),
  { initialSourceIds: () => [] },
);

const emit = defineEmits<{
  close: [];
  created: [amendment: AmendmentDto];
  /** Show the created transactional. */
  view: [id: string];
  /** The server refused it because something moved: refetch. */
  conflict: [];
  /** Base blocks the transactional rewrites, to mark them in the text. */
  passage: [blockIds: string[]];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const { member } = useMe();
const formId = useId();
const { join } = useTransactionalProgressText();

const heading = useTemplateRef<HTMLElement>("heading");
const sentHeading = useTemplateRef<HTMLElement>("sentHeading");
const editor = useTemplateRef<{ flush: () => void; focus: () => void }>(
  "editor",
);
const justificationInput = useTemplateRef<{
  textareaRef?: HTMLTextAreaElement;
}>("justificationInput");
const choices = useTemplateRef<HTMLElement>("choices");
const authorsBox = useTemplateRef<HTMLElement>("authorsBox");
const mainAuthorBox = useTemplateRef<HTMLElement>("mainAuthorBox");

// Sources ------------------------------------------------------------------------

const byId = computed(
  () => new Map(props.amendments.map((amendment) => [amendment.id, amendment])),
);
const candidates = computed(() =>
  transactionalSourceCandidates(props.amendments),
);

const sourceIds = ref<string[]>(
  props.initialSourceIds.filter((id) => {
    const amendment = byId.value.get(id);
    return amendment !== undefined && transactionalSourceEligible(amendment);
  }),
);
/** The list of amendments is open while nothing is chosen. */
const choosing = ref(sourceIds.value.length === 0);

/** Chosen ones that were decided or withdrawn meanwhile. */
const blockers = computed(() =>
  transactionalSourceBlockers(sourceIds.value, byId.value),
);
/** The most a transactional can combine (the server's limit). */
const sourceLimit = computed(() => transactionalSourceLimit(sourceIds.value));
/** Nothing to combine and nothing chosen: the empty state says so. */
const nothingToCombine = computed(
  () => candidates.value.length === 0 && sourceIds.value.length === 0,
);

/** Sources in order of presentation: the first one wins a collision. */
const sources = computed(() =>
  transactionalSourcesInOrder(
    sourceIds.value
      .map((id) => byId.value.get(id))
      .filter((amendment) => amendment !== undefined),
  ),
);

const labels = computed(() => blockLabels(props.base));

function whereOf(amendment: AmendmentDto): string | null {
  const first = touchedBlockIds(amendment.ops)[0];
  const label = first ? labels.value.get(first) : undefined;
  if (!label) return null;
  const paragraph =
    label.paragraph > 0
      ? t("amendment.detail.paragraph", { n: label.paragraph })
      : null;
  return [label.heading, paragraph].filter(Boolean).join(" · ") || null;
}

function authorsOf(amendment: AmendmentDto): string {
  return transactionalMemberList(amendment.authors);
}

/** Candidates, plus chosen ones that can no longer be combined (to remove them). */
const sourceItems = computed(() => {
  const listed = new Set(candidates.value.map((amendment) => amendment.id));
  const stale = sourceIds.value
    .filter((id) => !listed.has(id))
    .map((id) => byId.value.get(id))
    .filter((amendment) => amendment !== undefined);
  const chosen = new Set(sourceIds.value);
  return [...candidates.value, ...stale].map((amendment) => ({
    label: `${props.labelOf(amendment.id)} · ${authorsOf(amendment)}`,
    description: listed.has(amendment.id)
      ? (whereOf(amendment) ?? undefined)
      : t("transactional.composer.noLongerOpen"),
    value: amendment.id,
    // At the limit, only the chosen ones can still change (be removed).
    disabled: sourceLimit.value.full && !chosen.has(amendment.id),
  }));
});

// Text -----------------------------------------------------------------------------

const seed = shallowRef<TransactionalComposerSeed | null>(null);
const edited = ref<Block[]>([]);
const editorKey = ref(0);

function reseed(): void {
  seed.value = transactionalComposerSeed(
    props.base,
    sources.value.map(({ id, ops }) => ({ id, ops })),
    createId,
  );
  edited.value = seed.value.seed.map((block) => ({
    ...block,
    marks: block.marks.map((mark) => ({ ...mark })),
  }));
  editorKey.value += 1;
  emit(
    "passage",
    seed.value.passage.map((block) => block.id),
  );
}
reseed();

/** Whether the text differs from the starting one. Flushes the editor first. */
function textEdited(): boolean {
  editor.value?.flush();
  return (
    seed.value !== null &&
    !transactionalSameBlocks(edited.value, seed.value.seed)
  );
}

const ops = computed(() =>
  seed.value && seed.value.passage.length > 0
    ? diffPassage(
        seed.value.passage,
        edited.value,
        seed.value.anchorBefore,
        createId,
      )
    : [],
);
const opReasons = computed(() => [
  ...new Set(validateOps(props.base, ops.value).map((error) => error.reason)),
]);
const skipped = computed(() => seed.value?.skipped ?? []);
const hasPassage = computed(
  () => seed.value !== null && seed.value.passage.length > 0,
);
/**
 * Announced to screen readers only when it flips (the diff itself
 * re-renders on every keystroke, so it is not a live region).
 */
const changeStatus = computed(() =>
  ops.value.length > 0
    ? t("transactional.composer.hasChanges")
    : t("transactional.composer.noChanges"),
);

function onSourcesChange(value: unknown): void {
  const next = Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
  if (transactionalSameIds(next, sourceIds.value)) {
    sourceIds.value = next;
    return;
  }
  // Cancelling keeps the choice as it was: the group is controlled.
  if (
    textEdited() &&
    !window.confirm(t("transactional.composer.reseedConfirm"))
  ) {
    return;
  }
  sourceIds.value = next;
  serverReasons.value = [];
  // A new choice starts over: the next fields have not been reached yet.
  attempted.value = false;
  reseed();
}

function resetText(): void {
  if (
    textEdited() &&
    !window.confirm(t("transactional.composer.resetConfirm"))
  ) {
    return;
  }
  reseed();
}

// Who presents it ------------------------------------------------------------------

/** The Mesa presents it on behalf of the parties; members present it themselves. */
const isMesa = computed(() => props.document.can.moderate);

/**
 * Who the Mesa can name as proposers: the authors of the amendments it
 * combines, then the document's main presenter (it may well have asked for
 * the agreement).
 */
const parties = computed<MemberRef[]>(() => {
  const seen = new Map<string, MemberRef>();
  for (const source of sources.value) {
    for (const author of source.authors) {
      if (!seen.has(author.id)) seen.set(author.id, author);
    }
  }
  const proponent = props.document.proponent;
  if (proponent && !seen.has(proponent.id)) seen.set(proponent.id, proponent);
  return [...seen.values()];
});
const partyItems = computed(() =>
  parties.value.map((party) => ({
    label: memberLabel(party),
    value: party.id,
  })),
);
const authorIds = ref<string[]>([]);
const authorsTouched = ref(false);
const optionsOpen = ref(false);

/** Until the Mesa picks by hand, the authors of the sources present it. */
watch(
  sources,
  (list) => {
    if (authorsTouched.value) {
      const allowed = new Set(parties.value.map((party) => party.id));
      authorIds.value = authorIds.value.filter((id) => allowed.has(id));
      return;
    }
    authorIds.value = [
      ...new Set(list.flatMap((source) => source.authors.map((a) => a.id))),
    ];
  },
  { immediate: true },
);

function onAuthorsChange(value: unknown): void {
  authorIds.value = Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
  authorsTouched.value = true;
}

/** With several proposers, the Mesa names the main author. */
const mainAuthorId = ref<string | undefined>(undefined);
const mainAuthor = computed(() =>
  composerMainAuthor(isMesa.value ? authorIds.value : [], mainAuthorId.value),
);
const mainAuthorItems = computed(() =>
  authorIds.value.map((id) => {
    const party = parties.value.find((item) => item.id === id);
    return {
      label: party ? memberLabel(party) : id,
      value: id,
    };
  }),
);

// Sending ----------------------------------------------------------------------------

const justification = ref("");
const attempted = ref(false);
const busy = ref(false);
const serverReasons = ref<string[]>([]);
const created = ref<AmendmentDto | null>(null);
/** The created one as the live list has it now (acceptances move). */
const createdNow = computed(() =>
  created.value ? (byId.value.get(created.value.id) ?? created.value) : null,
);

const justificationMissing = computed(() => !justification.value.trim());
const sourcesMissing = computed(() => sourceIds.value.length === 0);
/**
 * The Mesa presents it on behalf of someone: with nobody picked, the server
 * would create it without authors.
 */
const authorsMissing = computed(
  () =>
    isMesa.value && sources.value.length > 0 && authorIds.value.length === 0,
);
const showAuthorsError = computed(
  () => authorsMissing.value && (attempted.value || authorsTouched.value),
);
const canSend = computed(
  () =>
    !busy.value &&
    !sourcesMissing.value &&
    !sourceLimit.value.over &&
    blockers.value.length === 0 &&
    ops.value.length > 0 &&
    opReasons.value.length === 0 &&
    !authorsMissing.value &&
    !mainAuthor.value.missing,
);

/**
 * What the footer says will happen once it is sent. The main authors of the
 * amendments it combines answer first (the proposer's own answer is taken
 * as given): when the proposer is all of them, it goes straight to the
 * Secretaría. The Mesa's is public at once.
 */
const nextNotice = computed(() => {
  if (isMesa.value) return t("transactional.composer.next.mesa");
  if (sources.value.length === 0) {
    return t("transactional.composer.next.memberGeneric");
  }
  const toAsk = transactionalAuthorsToAsk(
    sources.value,
    member.value?.id ?? null,
  );
  return toAsk.length === 0
    ? t("transactional.composer.next.self")
    : t("transactional.composer.next.member", {
        members: join(toAsk.map((party) => party.acronym)),
      });
});

/** Open the list of amendments and put focus on its first choice. */
async function focusChoices(): Promise<void> {
  choosing.value = true;
  await nextTick();
  choices.value
    ?.querySelector<HTMLElement>(
      '[role="checkbox"]:not([disabled]), input:not([disabled])',
    )
    ?.focus();
}

async function send(): Promise<void> {
  editor.value?.flush();
  await nextTick();
  attempted.value = true;
  if (sourcesMissing.value || sourceLimit.value.over) {
    // "Elige al menos una enmienda" or "como mucho …" is on screen.
    await focusChoices();
    return;
  }
  if (blockers.value.length > 0) return;
  if (ops.value.length === 0) {
    // "El texto es igual al original" is on screen: back to the editor.
    editor.value?.focus();
    return;
  }
  if (justificationMissing.value) {
    justificationInput.value?.textareaRef?.focus();
    return;
  }
  if (authorsMissing.value) {
    optionsOpen.value = true;
    await nextTick();
    authorsBox.value
      ?.querySelector<HTMLElement>("button, input, [tabindex]")
      ?.focus();
    return;
  }
  if (mainAuthor.value.missing) {
    optionsOpen.value = true;
    await nextTick();
    mainAuthorBox.value
      ?.querySelector<HTMLElement>('[role="radio"], input, button')
      ?.focus();
    return;
  }
  if (!canSend.value) return;
  busy.value = true;
  serverReasons.value = [];
  try {
    const body: TransactionalBody = {
      sourceIds: sources.value.map((amendment) => amendment.id),
      ops: ops.value,
      justification: justification.value.trim(),
      submit: true,
      // Members present it themselves; the Mesa names the parties.
      ...(isMesa.value
        ? {
            authorMemberIds: authorIds.value,
            mainAuthorMemberId: mainAuthor.value.value,
          }
        : {}),
    };
    const result = await api.send<AmendmentDto>(
      `${props.amendmentsUrl}/transactional`,
      { body },
    );
    created.value = result;
    emit("created", result);
    toast.add({
      title: t("transactional.composer.sent.toast"),
      color: "success",
      icon: "i-lucide-git-merge",
    });
    await nextTick();
    sentHeading.value?.focus();
  } catch (error) {
    serverReasons.value = amendmentErrorReasons(error);
    api.notifyError(error, "transactional.composer.sendFailed");
    if (api.isConflict(error)) emit("conflict");
  } finally {
    busy.value = false;
  }
}

const sentTitle = computed(() => {
  const amendment = createdNow.value;
  if (!amendment) return "";
  const code = amendment.code ?? "";
  return amendment.reviewState === "published"
    ? t("transactional.composer.sent.titlePublished", { code })
    : t("transactional.composer.sent.title", { code });
});

const nextSteps = computed(() =>
  createdNow.value
    ? transactionalNextSteps(
        createdNow.value,
        props.document.acceptedAmendments,
      )
    : [],
);

function stepText(step: TransactionalNextStep): string {
  switch (step.key) {
    case "authors":
      return t("transactional.nextSteps.authors", {
        members: join(step.members.map((party) => party.acronym)),
      });
    case "replaces":
      return t("transactional.nextSteps.replaces", {
        list: join(step.sourceIds.map((id) => props.labelOf(id))),
      });
    case "answer":
      return t(`transactional.nextSteps.answer.${step.rule}`);
    default:
      return t("transactional.nextSteps.secretaria");
  }
}

// Leaving --------------------------------------------------------------------------

/** Something typed that sending has not kept yet. */
function hasWork(): boolean {
  if (created.value) return false;
  return textEdited() || justification.value.trim() !== "";
}

function requestClose(): void {
  if (
    hasWork() &&
    !window.confirm(t("transactional.composer.discardConfirm"))
  ) {
    return;
  }
  emit("close");
}

onBeforeRouteLeave(() => {
  if (!hasWork()) return true;
  return window.confirm(t("transactional.composer.discardConfirm"));
});

function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasWork()) return;
  event.preventDefault();
  event.returnValue = "";
}

onMounted(() => {
  window.addEventListener("beforeunload", onBeforeUnload);
  void nextTick(() => {
    if (hasPassage.value) editor.value?.focus();
    else heading.value?.focus();
  });
});
onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", onBeforeUnload);
  emit("passage", []);
});

const stepBadge =
  "bg-primary/10 text-primary inline-flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums";
</script>

<template>
  <!-- Sent: what happens now -->
  <section
    v-if="createdNow"
    class="flex flex-col gap-5"
    :aria-labelledby="`${formId}-sent`"
  >
    <header class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <h2
          :id="`${formId}-sent`"
          ref="sentHeading"
          tabindex="-1"
          class="text-highlighted text-lg font-semibold outline-none"
        >
          {{ sentTitle }}
        </h2>
        <p class="text-muted text-sm">{{ document.title }}</p>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-label="t('common.close')"
        @click="emit('close')"
      />
    </header>

    <div class="flex flex-col gap-2">
      <h3 class="text-highlighted text-sm font-semibold">
        {{ t("transactional.composer.sent.next") }}
      </h3>
      <ol class="flex flex-col gap-2">
        <li
          v-for="(step, index) in nextSteps"
          :key="step.key"
          class="flex items-start gap-2 text-sm"
        >
          <span :class="stepBadge" aria-hidden="true">{{ index + 1 }}</span>
          <span class="text-default">{{ stepText(step) }}</span>
        </li>
      </ol>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <UButton
        icon="i-lucide-eye"
        :label="t('transactional.composer.sent.view')"
        @click="emit('view', createdNow.id)"
      />
      <UButton
        color="neutral"
        variant="ghost"
        :label="t('common.close')"
        @click="emit('close')"
      />
    </div>
  </section>

  <!-- Composing -->
  <form
    v-else
    :id="formId"
    class="flex flex-col gap-6"
    novalidate
    :aria-labelledby="`${formId}-title`"
    @submit.prevent="send"
  >
    <header class="flex items-start gap-2">
      <div class="min-w-0 flex-1">
        <h2
          :id="`${formId}-title`"
          ref="heading"
          tabindex="-1"
          class="text-highlighted text-lg font-semibold outline-none"
        >
          {{ t("transactional.composer.title") }}
        </h2>
        <p class="text-muted text-sm">
          {{ t("transactional.composer.intro") }}
        </p>
      </div>
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="sm"
        :aria-label="t('transactional.composer.close')"
        @click="requestClose"
      />
    </header>

    <!-- Step: which amendments -->
    <section class="flex flex-col gap-2" :aria-labelledby="`${formId}-sources`">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3
          :id="`${formId}-sources`"
          class="text-highlighted flex items-center gap-2 text-sm font-semibold"
        >
          <span :class="stepBadge" aria-hidden="true">1</span>
          <span class="sr-only">
            {{ t("amendment.composer.step", { n: 1 }) }}
          </span>
          {{ t("transactional.composer.steps.sources") }}
        </h3>
        <UButton
          v-if="candidates.length > 0 || sourceIds.length > 0"
          color="primary"
          variant="link"
          size="sm"
          class="px-0"
          :aria-expanded="choosing"
          :aria-controls="`${formId}-choices`"
          :label="
            choosing
              ? t('transactional.composer.doneChoosing')
              : t('transactional.composer.change')
          "
          @click="choosing = !choosing"
        />
      </div>

      <CommonEmptyState
        v-if="candidates.length === 0 && sourceIds.length === 0"
        icon="i-lucide-git-merge"
        size="sm"
        :title="t('transactional.composer.noCandidates')"
        :description="t('transactional.composer.noCandidatesHint')"
      />

      <template v-else>
        <ul
          v-if="!choosing && sources.length > 0"
          class="flex flex-wrap gap-1.5"
        >
          <li v-for="source in sources" :key="source.id">
            <UBadge
              color="secondary"
              variant="soft"
              icon="i-lucide-git-merge"
              :label="`${labelOf(source.id)} · ${authorsOf(source)}`"
            />
          </li>
        </ul>
        <div
          v-show="choosing"
          :id="`${formId}-choices`"
          ref="choices"
          class="flex flex-col gap-2"
        >
          <UCheckboxGroup
            :model-value="sourceIds"
            :items="sourceItems"
            :legend="t('transactional.composer.sourcesLegend')"
            variant="card"
            size="sm"
            @update:model-value="onSourcesChange"
          />
          <p class="text-muted text-xs">
            {{ t("transactional.composer.sourcesHint") }}
            <!-- Always there, so reaching the limit is announced. -->
            <span aria-live="polite">
              <template v-if="sourceLimit.full && !sourceLimit.over">
                {{
                  t("transactional.composer.limitReached", {
                    max: sourceLimit.max,
                  })
                }}
              </template>
            </span>
          </p>
        </div>
        <p
          v-if="attempted && sourcesMissing"
          class="text-error text-sm"
          role="alert"
        >
          {{ t("transactional.composer.noSourcesChosen") }}
        </p>
        <UAlert
          v-if="sourceLimit.over"
          color="warning"
          variant="subtle"
          icon="i-lucide-circle-alert"
          role="alert"
          :description="
            t('transactional.composer.tooMany', { max: sourceLimit.max })
          "
        />
        <UAlert
          v-if="blockers.length > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-circle-alert"
          role="alert"
          :title="t('transactional.composer.blockedTitle')"
          :description="
            t(
              'transactional.composer.blocked',
              { labels: blockers.map(labelOf).join(', ') },
              blockers.length,
            )
          "
        />
      </template>
    </section>

    <template v-if="sources.length > 0">
      <!-- Step: write the text -->
      <section class="flex flex-col gap-2" :aria-labelledby="`${formId}-write`">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3
            :id="`${formId}-write`"
            class="text-highlighted flex items-center gap-2 text-sm font-semibold"
          >
            <span :class="stepBadge" aria-hidden="true">2</span>
            <span class="sr-only">
              {{ t("amendment.composer.step", { n: 2 }) }}
            </span>
            {{ t("transactional.composer.steps.write") }}
          </h3>
          <UButton
            v-if="hasPassage"
            icon="i-lucide-rotate-ccw"
            color="neutral"
            variant="ghost"
            size="xs"
            :label="t('transactional.composer.reset')"
            @click="resetText"
          />
        </div>
        <UAlert
          v-if="skipped.length > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-git-compare"
          :title="t('transactional.composer.skippedTitle')"
          :description="
            t(
              'transactional.composer.skipped',
              { labels: skipped.map(labelOf).join(', ') },
              skipped.length,
            )
          "
        />
        <CommonEmptyState
          v-if="!hasPassage"
          icon="i-lucide-file-question"
          size="sm"
          :title="t('transactional.composer.noPassage')"
        />
        <template v-else>
          <ClientOnly>
            <ContentBlockEditor
              :key="editorKey"
              ref="editor"
              v-model="edited"
              compact
              :label="t('transactional.composer.editorLabel')"
            />
            <template #fallback>
              <USkeleton aria-hidden="true" class="h-32 w-full" />
            </template>
          </ClientOnly>
          <p class="text-dimmed text-xs">
            {{ t("transactional.composer.writeHint") }}
          </p>
          <span class="sr-only" aria-live="polite">{{ changeStatus }}</span>
        </template>
      </section>

      <!-- Step: check the change -->
      <section
        v-if="hasPassage"
        class="flex flex-col gap-2"
        :aria-labelledby="`${formId}-check`"
      >
        <h3
          :id="`${formId}-check`"
          class="text-highlighted flex items-center gap-2 text-sm font-semibold"
        >
          <span :class="stepBadge" aria-hidden="true">3</span>
          <span class="sr-only">
            {{ t("amendment.composer.step", { n: 3 }) }}
          </span>
          {{ t("transactional.composer.steps.check") }}
        </h3>
        <div class="border-default rounded-md border p-3 sm:p-4">
          <ContentAmendmentDiff
            v-if="ops.length > 0"
            :id="`${formId}-preview`"
            :base="base"
            :ops="ops"
            :context="1"
          />
          <p v-else class="text-muted text-sm">
            {{ t("transactional.composer.noChanges") }}
          </p>
        </div>
      </section>

      <UAlert
        v-if="opReasons.length > 0 || serverReasons.length > 0"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        role="alert"
        :title="t('transactional.composer.errorsTitle')"
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

      <!-- Step: why -->
      <UFormField
        required
        :error="
          attempted && justificationMissing
            ? t('transactional.composer.justificationRequired')
            : undefined
        "
        :help="t('transactional.composer.justificationHelp')"
      >
        <template #label>
          <span
            class="text-highlighted flex items-center gap-2 text-sm font-semibold"
          >
            <span :class="stepBadge" aria-hidden="true">4</span>
            <span class="sr-only">
              {{ t("amendment.composer.step", { n: 4 }) }}
            </span>
            {{ t("transactional.composer.steps.why") }}
          </span>
        </template>
        <UTextarea
          ref="justificationInput"
          v-model="justification"
          :rows="3"
          autoresize
          :maxrows="12"
          :maxlength="20000"
          class="w-full"
          :placeholder="t('transactional.composer.justificationPlaceholder')"
        />
      </UFormField>

      <!-- The Mesa names who presents it (by default, the authors). -->
      <UCollapsible v-if="isMesa" v-model:open="optionsOpen">
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          class="px-0"
          :icon="optionsOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          :label="t('transactional.composer.authorsOptions')"
        />
        <template #content>
          <div
            ref="authorsBox"
            class="border-default mt-2 rounded-md border p-3 sm:p-4"
          >
            <UFormField
              :label="t('transactional.composer.authors')"
              :help="t('transactional.composer.authorsHint')"
              :error="
                showAuthorsError
                  ? t('transactional.composer.authorsRequired')
                  : undefined
              "
              required
            >
              <USelectMenu
                :model-value="authorIds"
                :items="partyItems"
                value-key="value"
                multiple
                class="w-full"
                :placeholder="t('transactional.composer.authorsPlaceholder')"
                :aria-label="
                  selectMenuLabel(
                    t('transactional.composer.authors'),
                    partyItems,
                    authorIds,
                    t('transactional.composer.authorsPlaceholder'),
                  )
                "
                :search-input="labelledSearch(t('common.search'))"
                @update:model-value="onAuthorsChange"
              />
            </UFormField>
            <div v-if="mainAuthor.required" ref="mainAuthorBox" class="mt-4">
              <UFormField
                :label="t('amendment.composer.mainAuthor')"
                required
                :help="t('transactional.composer.mainAuthorHint')"
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
          </div>
        </template>
      </UCollapsible>
    </template>

    <footer
      class="border-default bg-default sticky bottom-0 -mx-1 flex flex-col gap-2 border-t px-1 pt-3 pb-1"
    >
      <p class="text-muted flex items-start gap-1.5 text-xs">
        <UIcon
          name="i-lucide-route"
          class="mt-px size-3.5 shrink-0"
          aria-hidden="true"
        />
        {{ nextNotice }}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('amendment.actions.cancel')"
          :disabled="busy"
          @click="requestClose"
        />
        <UButton
          type="submit"
          class="ms-auto"
          icon="i-lucide-send"
          :loading="busy"
          :disabled="busy || nothingToCombine || blockers.length > 0"
          :label="t('transactional.composer.send')"
        />
      </div>
    </footer>
  </form>
</template>
