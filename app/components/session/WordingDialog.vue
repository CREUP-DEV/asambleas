<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type { Block } from "~~/shared/types/content";
import { consolidate } from "~~/shared/utils/content/consolidate";
import { diffPassage } from "~~/shared/utils/content/diff";
import { validateOps } from "~~/shared/utils/content/ops";
import {
  amendmentPassageOps,
  blocksPlainText,
  passageClashes,
  passageCoverage,
} from "~~/shared/utils/content/passageClashes";
import { passageFragment } from "~~/shared/utils/content/passages";
import { sessionWordingSeed } from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * The Mesa words a passage where approved amendments collide (user's
 * decisions of 2026-11-19). Each one is approved over the text as it
 * stands, so the passage reads as the automatic proposal until the Mesa
 * fixes it: where they change the same text the last approved wins, where
 * they only touch both apply. A deletion wins on its own over the changes
 * inside what it deletes; the Mesa may keep it so or correct it.
 *
 * Laid out to tell the amendments apart (user's decision of 2026-11-20):
 * first «Dónde chocan», each stretch two or more of them change, the base
 * text and what each one puts there, each with its own code and colour
 * (passageClashes); then, folded, everything each one changes in the
 * passage and the automatic proposal. The editor starts from the automatic
 * proposal or from one amendment as approved, and a line says how much of
 * each the wording keeps (passageCoverage, a word count). The changes over
 * the base, what is stored (diffPassage, like an amendment's), stay folded.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.wordingDialog.open,
  set: (value: boolean) => {
    session.wordingDialog.open = value;
  },
});

const passage = computed(
  () =>
    session.preview.value.passages.find(
      (item) => item.key === session.wordingDialog.passageKey,
    ) ?? null,
);
const codes = computed(() =>
  (passage.value?.amendmentIds ?? []).map(session.label).join(", "),
);
const now = computed(() =>
  passage.value
    ? passageFragment(session.preview.value.annotated, passage.value.blockIds)
    : [],
);
const superseded = computed(() =>
  passage.value
    ? session.preview.value.superseded.filter((item) =>
        item.blockIds.some((id) => passage.value!.blockIds.includes(id)),
      )
    : [],
);

// Each amendment of the passage ----------------------------------------------------

/** Colours that tell the amendments apart: none reads as added or removed. */
const AMENDMENT_COLORS = ["info", "primary", "neutral", "secondary"] as const;

const passageAmendments = computed(() => {
  const current = passage.value;
  if (!current) return [];
  const byId = new Map(session.amendments.value.map((item) => [item.id, item]));
  return current.amendmentIds.flatMap((id, index) => {
    const amendment = byId.get(id);
    if (!amendment) return [];
    const main =
      amendment.authors.find(
        (author) => author.id === amendment.mainAuthorId,
      ) ?? amendment.authors[0];
    return [
      {
        id,
        code: session.label(id),
        author: main?.acronym ?? null,
        color: AMENDMENT_COLORS[index % AMENDMENT_COLORS.length]!,
        ops: amendmentPassageOps(amendment, current.blockIds),
      },
    ];
  });
});
const amendmentById = computed(
  () => new Map(passageAmendments.value.map((item) => [item.id, item])),
);

const clashes = computed(() =>
  passage.value
    ? passageClashes(
        session.base.value,
        passageAmendments.value,
        passage.value.blockIds,
      )
    : [],
);

/** What each amendment changes in the passage: open when nothing clashes. */
const eachOpen = ref(false);
const automaticOpen = ref(false);
const diffOpen = ref(false);

// The editor ---------------------------------------------------------------------

/** Where the editor started from: the automatic proposal or an amendment. */
const startedFrom = ref<string | null>(null);

function seedFrom(source: string | null) {
  const current = passage.value;
  if (!current) return null;
  if (source === null) {
    return sessionWordingSeed(
      session.base.value,
      session.preview.value,
      current,
    );
  }
  const amendment = amendmentById.value.get(source);
  if (!amendment) return null;
  return sessionWordingSeed(
    session.base.value,
    consolidate(session.base.value, [{ id: amendment.id, ops: amendment.ops }]),
    current,
  );
}

const seed = ref<ReturnType<typeof sessionWordingSeed> | null>(null);
const edited = ref<Block[]>([]);
const editorKey = ref(0);

function reseed(source: string | null = null): void {
  seed.value = seedFrom(source);
  startedFrom.value = source;
  edited.value = (seed.value?.seed ?? []).map((block) =>
    structuredClone(toRaw(block)),
  );
  editorKey.value += 1;
}

// A fresh start each time it opens, or when it moves to another passage.
watch(
  () => [open.value, session.wordingDialog.passageKey] as const,
  ([isOpen]) => {
    if (!isOpen) return;
    reseed();
    eachOpen.value = clashes.value.length === 0;
    automaticOpen.value = !session.wordingDialog.editing;
    diffOpen.value = false;
  },
  { immediate: true },
);

const ops = computed(() =>
  seed.value && seed.value.basePassage.length > 0
    ? diffPassage(
        seed.value.basePassage,
        edited.value,
        seed.value.anchorBefore,
        createId,
      )
    : [],
);
const opErrors = computed(() => validateOps(session.base.value, ops.value));
const canSave = computed(
  () =>
    Boolean(passage.value) &&
    ops.value.length > 0 &&
    opErrors.value.length === 0 &&
    !session.busy.value.wording,
);

/** Each amendment as approved over the passage, for the coverage line. */
const amendmentTexts = computed(
  () =>
    new Map(
      passageAmendments.value.map((amendment) => [
        amendment.id,
        blocksPlainText(seedFrom(amendment.id)?.seed ?? []),
      ]),
    ),
);
const coverage = computed(() => {
  const baseText = blocksPlainText(seed.value?.basePassage ?? []);
  const wordingText = blocksPlainText(edited.value);
  return passageAmendments.value.map((amendment) => ({
    ...amendment,
    level: passageCoverage(
      baseText,
      amendmentTexts.value.get(amendment.id) ?? baseText,
      wordingText,
    ),
  }));
});

const description = computed(() => {
  if (!passage.value) return t("session.wording.changed");
  if (passage.value.status === "worded") return t("session.wording.worded");
  if (passage.value.status === "automatic") {
    const changed = [
      ...new Set(superseded.value.map((item) => item.amendmentId)),
    ];
    return t(
      "session.wording.deletionWins",
      {
        by: [...new Set(superseded.value.map((item) => item.by))]
          .map(session.label)
          .join(", "),
        codes: changed.map(session.label).join(", "),
      },
      changed.length,
    );
  }
  return t("session.wording.pending");
});

async function save(): Promise<void> {
  if (!passage.value || !canSave.value) return;
  if (await session.setWording(passage.value, ops.value)) open.value = false;
}

async function backToAutomatic(): Promise<void> {
  const wordingId = passage.value?.wordingId;
  if (!wordingId) return;
  if (await session.removeWording(wordingId)) open.value = false;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('session.wording.title', { codes })"
    :description="description"
    :ui="{ content: 'sm:max-w-5xl', description: 'sr-only' }"
  >
    <template #body>
      <!-- In the body, not the header: long, it would cover the passage on
           a narrow screen. -->
      <p class="text-default mb-4 text-sm">{{ description }}</p>
      <div v-if="passage" class="space-y-5">
        <!-- Where they clash: the base text and what each one puts there. -->
        <section
          v-if="clashes.length > 0"
          class="space-y-3"
          aria-labelledby="wording-clashes-title"
        >
          <h3
            id="wording-clashes-title"
            class="text-highlighted text-sm font-medium"
          >
            {{ t("session.wording.clashesTitle") }}
          </h3>
          <div
            v-for="clash in clashes"
            :key="clash.key"
            class="border-warning/60 space-y-3 rounded-lg border p-3"
            data-testid="wording-clash"
          >
            <p class="text-default flex items-center gap-2 text-sm font-medium">
              <UIcon
                name="i-lucide-git-compare-arrows"
                class="text-warning size-4 shrink-0"
                aria-hidden="true"
              />
              {{
                t("session.wording.clashAt", {
                  codes: clash.proposals
                    .map((proposal) => session.label(proposal.amendmentId))
                    .join(", "),
                })
              }}
            </p>
            <div class="space-y-1">
              <p class="text-muted text-xs font-medium">
                {{ t("session.wording.original") }}
              </p>
              <ContentView :blocks="[clash.base]" :headings="false" />
            </div>
            <div
              class="grid gap-3"
              :class="clash.proposals.length > 1 ? 'md:grid-cols-2' : ''"
            >
              <div
                v-for="proposal in clash.proposals"
                :key="proposal.amendmentId"
                class="border-default min-w-0 space-y-2 rounded-md border p-2"
              >
                <div class="flex items-center gap-2">
                  <UBadge
                    :color="
                      amendmentById.get(proposal.amendmentId)?.color ??
                      'neutral'
                    "
                    variant="subtle"
                    :label="session.label(proposal.amendmentId)"
                  />
                  <span
                    v-if="amendmentById.get(proposal.amendmentId)?.author"
                    class="text-muted text-xs"
                  >
                    {{ amendmentById.get(proposal.amendmentId)?.author }}
                  </span>
                </div>
                <p v-if="proposal.deletes" class="text-default text-sm">
                  {{ t("session.wording.deletesBlock") }}
                </p>
                <ContentAmendmentDiff
                  v-else-if="proposal.ops.length > 0"
                  :id="proposal.amendmentId"
                  :base="[clash.base]"
                  :ops="proposal.ops"
                />
                <p v-else class="text-muted text-sm">
                  {{ t("session.wording.formatOnly") }}
                </p>
              </div>
            </div>
          </div>
        </section>

        <!-- Everything each one changes in the passage. -->
        <UCollapsible v-model:open="eachOpen">
          <UButton
            color="neutral"
            variant="link"
            size="sm"
            class="px-0"
            :icon="eachOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
            :label="t('session.wording.eachTitle')"
          />
          <template #content>
            <div
              class="mt-2 grid gap-3"
              :class="passageAmendments.length > 1 ? 'lg:grid-cols-2' : ''"
            >
              <div
                v-for="amendment in passageAmendments"
                :key="amendment.id"
                class="border-default min-w-0 space-y-2 rounded-md border p-2"
              >
                <div class="flex items-center gap-2">
                  <UBadge
                    :color="amendment.color"
                    variant="subtle"
                    :label="amendment.code"
                  />
                  <span v-if="amendment.author" class="text-muted text-xs">
                    {{ amendment.author }}
                  </span>
                </div>
                <ContentAmendmentDiff
                  :id="amendment.id"
                  :base="session.base.value"
                  :ops="amendment.ops"
                />
              </div>
            </div>
          </template>
        </UCollapsible>

        <!-- The automatic proposal: how the passage reads now. -->
        <UCollapsible v-model:open="automaticOpen">
          <UButton
            color="neutral"
            variant="link"
            size="sm"
            class="px-0"
            :icon="
              automaticOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
            "
            :label="
              t(
                passage.status === 'worded'
                  ? 'session.wording.now'
                  : 'session.wording.automaticProposal',
              )
            "
          />
          <template #content>
            <div class="mt-2">
              <ContentView
                :annotated="now"
                mode="diff"
                :label="session.label"
                :headings="false"
              />
            </div>
          </template>
        </UCollapsible>

        <section
          v-if="session.wordingDialog.editing"
          class="space-y-2"
          aria-labelledby="wording-text-title"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3
              id="wording-text-title"
              class="text-highlighted text-sm font-medium"
            >
              {{ t("session.wording.text") }}
            </h3>
            <div
              class="flex flex-wrap items-center gap-1.5"
              role="group"
              :aria-label="t('session.wording.startFrom')"
            >
              <span class="text-muted text-xs">
                {{ t("session.wording.startFrom") }}
              </span>
              <UButton
                size="xs"
                color="neutral"
                :variant="startedFrom === null ? 'subtle' : 'outline'"
                :label="
                  t(
                    passage.status === 'worded'
                      ? 'session.wording.startCurrent'
                      : 'session.wording.startAutomatic',
                  )
                "
                @click="reseed(null)"
              />
              <UButton
                v-for="amendment in passageAmendments"
                :key="amendment.id"
                size="xs"
                :color="amendment.color"
                :variant="startedFrom === amendment.id ? 'subtle' : 'outline'"
                :label="amendment.code"
                :aria-label="
                  t('session.wording.startFromAmendment', {
                    code: amendment.code,
                  })
                "
                @click="reseed(amendment.id)"
              />
            </div>
          </div>
          <ClientOnly>
            <ContentBlockEditor
              :key="editorKey"
              v-model="edited"
              compact
              :label="t('session.wording.text')"
            />
            <template #fallback>
              <USkeleton aria-hidden="true" class="h-40 w-full" />
            </template>
          </ClientOnly>

          <!-- How much of each amendment the wording keeps. -->
          <p
            class="text-muted flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
            aria-live="polite"
            data-testid="wording-coverage"
          >
            <span>{{ t("session.wording.coverage") }}</span>
            <span
              v-for="item in coverage"
              :key="item.id"
              class="flex items-center gap-1.5"
            >
              <UBadge :color="item.color" variant="subtle" :label="item.code" />
              <span class="text-default">{{
                t(`session.wording.coverageLevel.${item.level}`)
              }}</span>
            </span>
          </p>

          <UAlert
            v-if="ops.length > 0 && opErrors.length > 0"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('session.wording.invalid')"
          />

          <UCollapsible v-model:open="diffOpen">
            <UButton
              color="neutral"
              variant="link"
              size="sm"
              class="px-0"
              :icon="diffOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
              :label="t('session.wording.diff')"
            />
            <template #content>
              <div class="mt-2" aria-live="polite">
                <p v-if="ops.length === 0" class="text-muted text-sm">
                  {{ t("session.wording.noChanges") }}
                </p>
                <ContentAmendmentDiff
                  v-else
                  id="passage-wording"
                  :base="session.base.value"
                  :ops="ops"
                />
              </div>
            </template>
          </UCollapsible>
        </section>
      </div>
    </template>
    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <template v-if="!passage">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.close')"
            @click="close"
          />
        </template>
        <template v-else-if="!session.wordingDialog.editing">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-pen-line"
            :label="t('session.wording.correct')"
            @click="session.wordingDialog.editing = true"
          />
          <UButton
            color="primary"
            icon="i-lucide-check"
            :label="t('session.wording.keep')"
            @click="close"
          />
        </template>
        <template v-else>
          <UButton
            v-if="passage.wordingId"
            color="neutral"
            variant="ghost"
            icon="i-lucide-eraser"
            :label="t('session.wording.automatic')"
            :loading="
              Boolean(session.busy.value[`wording-${passage.wordingId}`])
            "
            @click="backToAutomatic"
          />
          <UButton
            color="neutral"
            variant="outline"
            :label="t('session.wording.later')"
            @click="close"
          />
          <UButton
            color="primary"
            icon="i-lucide-check"
            :label="t('session.wording.save')"
            :disabled="!canSave"
            :loading="Boolean(session.busy.value.wording)"
            @click="save"
          />
        </template>
      </div>
    </template>
  </UModal>
</template>
