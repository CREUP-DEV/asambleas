<script setup lang="ts">
import type { VoteInput } from "~~/shared/types/api";
import type { ConsolidationConflict } from "~~/shared/types/content";
import {
  isSessionVoteReady,
  sessionCleanVote,
  sessionEmptyVote,
  sessionVoteOutcome,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Final vote on the whole text. The document's majority is the default.
 * When approved, the server consolidates the approved amendments; if they
 * cannot be applied together it answers 409 and the conflicts are listed.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.finalVoteDialog.open,
  set: (value: boolean) => {
    session.finalVoteDialog.open = value;
  },
});
const document = computed(() => session.document.value);

const vote = ref<VoteInput>(sessionEmptyVote("simple"));
const serverConflicts = ref<ConsolidationConflict[]>([]);
const serverUndecided = ref<string[]>([]);
const serverTie = ref(false);

watch(open, (isOpen) => {
  if (!isOpen) return;
  vote.value = sessionEmptyVote(document.value?.majority ?? "simple");
  serverConflicts.value = [];
  serverUndecided.value = [];
  serverTie.value = false;
});

const undecided = computed(() => session.undecided.value);
const conflicts = computed(() =>
  serverConflicts.value.length > 0
    ? serverConflicts.value
    : session.preview.value.conflicts,
);
const outcome = computed(() =>
  sessionVoteOutcome(vote.value, session.settings.value),
);
const blocked = computed(
  () =>
    !document.value ||
    undecided.value.length > 0 ||
    !isSessionVoteReady(vote.value, outcome.value),
);

function conflictText(conflict: ConsolidationConflict): string {
  const code = session.label(conflict.amendmentId);
  return conflict.conflictsWith.length > 0
    ? t("session.preview.conflictWith", {
        code,
        others: conflict.conflictsWith.map(session.label).join(", "),
      })
    : t("session.preview.conflictInvalid", { code });
}

async function submit(): Promise<void> {
  if (blocked.value) return;
  const result = await session.finalVote({
    vote: sessionCleanVote(vote.value),
  });
  if (result.ok) {
    open.value = false;
    return;
  }
  serverConflicts.value = result.conflicts;
  serverUndecided.value = result.undecided;
  serverTie.value = result.tie;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('session.finalVote.title')"
    :description="document?.title"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <form
        v-if="document"
        id="session-final-vote-form"
        class="space-y-4"
        @submit.prevent="submit"
      >
        <UAlert
          v-if="undecided.length > 0 || serverUndecided.length > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-list-todo"
          :title="
            t(
              'session.finalVote.undecided',
              { count: Math.max(undecided.length, serverUndecided.length) },
              Math.max(undecided.length, serverUndecided.length),
            )
          "
          :description="
            (serverUndecided.length > 0
              ? serverUndecided
              : undecided.map((a) => a.id)
            )
              .map(session.label)
              .join(', ')
          "
        />
        <UAlert
          v-if="conflicts.length > 0"
          color="error"
          variant="subtle"
          icon="i-lucide-git-compare"
          :title="t('session.finalVote.conflictsTitle')"
        >
          <template #description>
            <ul class="mt-1 list-disc space-y-1 ps-4">
              <li v-for="conflict in conflicts" :key="conflict.amendmentId">
                {{ conflictText(conflict) }}
              </li>
            </ul>
            <p class="mt-2">{{ t("session.finalVote.conflictsHint") }}</p>
          </template>
        </UAlert>
        <UAlert
          v-if="serverTie"
          color="warning"
          variant="subtle"
          icon="i-lucide-scale"
          :title="t('session.vote.tieTitle')"
          :description="t('session.vote.tieRepeat')"
        />

        <SessionVoteFields v-model="vote" :settings="session.settings.value" />
      </form>
    </template>
    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="close"
        />
        <UButton
          type="submit"
          form="session-final-vote-form"
          icon="i-lucide-gavel"
          :label="t('session.finalVote.submit')"
          :loading="Boolean(session.busy.value['final-vote'])"
          :disabled="blocked"
        />
      </div>
    </template>
  </UModal>
</template>
