<script setup lang="ts">
import { createId } from "@paralleldrive/cuid2";
import type { Block } from "~~/shared/types/content";
import { diffPassage } from "~~/shared/utils/content/diff";
import { validateOps } from "~~/shared/utils/content/ops";
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
 * The editor starts from the passage as it reads now and the wording is
 * stored as changes against the base (diffPassage), like an amendment's.
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

const seed = ref<ReturnType<typeof sessionWordingSeed> | null>(null);
const edited = ref<Block[]>([]);
const editorKey = ref(0);

function reseed(): void {
  if (!passage.value) {
    seed.value = null;
    return;
  }
  seed.value = sessionWordingSeed(
    session.base.value,
    session.preview.value,
    passage.value,
  );
  edited.value = seed.value.seed.map((block) => structuredClone(toRaw(block)));
  editorKey.value += 1;
}

// A fresh start each time it opens, or when it moves to another passage.
watch(
  () => [open.value, session.wordingDialog.passageKey] as const,
  ([isOpen]) => {
    if (isOpen) reseed();
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

const description = computed(() => {
  if (!passage.value) return t("session.wording.changed");
  if (passage.value.status === "worded") return t("session.wording.worded");
  if (passage.value.status === "automatic") {
    return t("session.wording.deletionWins", {
      by: [...new Set(superseded.value.map((item) => item.by))]
        .map(session.label)
        .join(", "),
      codes: [...new Set(superseded.value.map((item) => item.amendmentId))]
        .map(session.label)
        .join(", "),
    });
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
    :ui="{ content: 'sm:max-w-5xl' }"
  >
    <template #body>
      <div v-if="passage" class="space-y-4">
        <section class="space-y-2">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.wording.now") }}
          </h3>
          <ContentView
            :annotated="now"
            mode="provenance"
            :label="session.label"
            :headings="false"
          />
        </section>

        <div
          v-if="session.wordingDialog.editing"
          class="grid gap-4 xl:grid-cols-2"
        >
          <section class="min-w-0 space-y-2">
            <h3 class="text-highlighted text-sm font-medium">
              {{ t("session.wording.text") }}
            </h3>
            <ClientOnly>
              <ContentBlockEditor
                :key="editorKey"
                v-model="edited"
                compact
                :label="t('session.wording.text')"
                autofocus
              />
              <template #fallback>
                <USkeleton aria-hidden="true" class="h-40 w-full" />
              </template>
            </ClientOnly>
            <UButton
              icon="i-lucide-rotate-ccw"
              color="neutral"
              variant="ghost"
              size="sm"
              :label="t('session.wording.reset')"
              @click="reseed"
            />
          </section>
          <section class="min-w-0 space-y-2" aria-live="polite">
            <h3 class="text-highlighted text-sm font-medium">
              {{ t("session.wording.diff") }}
            </h3>
            <p v-if="ops.length === 0" class="text-muted text-sm">
              {{ t("session.wording.noChanges") }}
            </p>
            <ContentAmendmentDiff
              v-else
              id="passage-wording"
              :base="session.base.value"
              :ops="ops"
            />
            <UAlert
              v-if="ops.length > 0 && opErrors.length > 0"
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              :title="t('session.wording.invalid')"
            />
          </section>
        </div>
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
