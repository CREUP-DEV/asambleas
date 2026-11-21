<script setup lang="ts">
import { amendmentVoteMajority } from "~~/shared/constants/domain";
import type { VoteInput } from "~~/shared/types/api";
import {
  isSessionVoteReady,
  sessionCleanVote,
  sessionEmptyVote,
  sessionVoteOutcome,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import type { LiveTallyAnnounce } from "~/composables/session/liveTally";

/**
 * One vote on a bloc of amendments (user's decision of 2026-11-21): the
 * amendments chosen in the bloc, or the bloc on screen, are voted together
 * with any counted method (by show of hands, registered delegation by
 * delegation, secret, counted live too, or the portal), under the
 * majority the document's amendments need. Carried, every one is approved;
 * not carried, every one is rejected. Approving them by assent stays in
 * «Aprobar en bloque por asentimiento».
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.blocVoteDialog.open,
  set: (value: boolean) => {
    session.blocVoteDialog.open = value;
  },
});
const ids = computed(() => session.blocVoteDialog.ids);
const codes = computed(() => ids.value.map((id) => session.label(id)));

const proposedMajority = computed(() =>
  session.document.value
    ? amendmentVoteMajority(session.document.value.kind)
    : "simple",
);
const vote = ref<VoteInput>(sessionEmptyVote(proposedMajority.value));
watch(open, (isOpen) => {
  if (isOpen) vote.value = sessionEmptyVote(proposedMajority.value);
});
const outcome = computed(() =>
  sessionVoteOutcome(
    vote.value,
    session.settings.value,
    session.voteHeadcount.value,
  ),
);
const blocked = computed(
  () => ids.value.length < 2 || !isSessionVoteReady(vote.value, outcome.value),
);
/** What a secret vote counted here announces on the projection. */
const announce = computed<LiveTallyAnnounce | null>(() => ({
  subject: { type: "decision", id: null },
  question: t("session.blocVote.question", { codes: codes.value.join(", ") }),
}));
const saving = computed(() => Boolean(session.busy.value["bloc-vote"]));

async function submit(): Promise<void> {
  if (blocked.value) return;
  if (await session.voteBloc(ids.value, sessionCleanVote(vote.value))) {
    open.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('session.blocVote.title', { count: ids.length }, ids.length)"
    :description="t('session.blocVote.description')"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <form
        id="session-bloc-vote-form"
        class="space-y-4"
        @submit.prevent="submit"
      >
        <p class="text-highlighted text-sm font-medium">
          {{ codes.join(", ") }}
        </p>
        <SessionVoteFields
          v-model="vote"
          :settings="session.settings.value"
          :headcount="session.voteHeadcount.value"
          :announce="announce"
        />
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
          form="session-bloc-vote-form"
          icon="i-lucide-gavel"
          :label="t('session.blocVote.submit')"
          :loading="saving"
          :disabled="blocked"
        />
      </div>
    </template>
  </UModal>
</template>
