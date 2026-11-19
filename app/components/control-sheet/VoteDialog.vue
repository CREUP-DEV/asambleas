<script setup lang="ts">
import { ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";
import {
  VOTE_METHODS,
  type Majority,
  type VoteMethod,
} from "~~/shared/constants/domain";
import type { VoteInput } from "~~/shared/types/api";
import {
  isSessionFinalVoteReady,
  sessionEmptyVote,
  sessionVoteOutcome,
} from "~/composables/session/sessionModel";
import type { ItemVoteContext } from "./-model";

/**
 * A vote recorded from the control sheet (an amendment's, a document's
 * final vote): the console's own fields (SessionVoteFields: the members
 * present from the latest headcount, those not cast worked out, the
 * result previewed; a final vote by assent may be unanimous), so what is stored is what the console would store. Nothing
 * is projected from here.
 */
const props = defineProps<{
  title: string;
  description?: string;
  /** The majority it starts with (the document's, or an amendment's). */
  majority: Majority;
  context: ItemVoteContext;
  busy: boolean;
  /**
   * Assent as a method (a document's final vote); an amendment's vote
   * leaves it out, since approving by assent is its own action.
   */
  withAssent?: boolean;
}>();
const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ submit: [vote: VoteInput] }>();

const { t } = useI18n();

const vote = ref<VoteInput>(sessionEmptyVote(props.majority));
watch(open, (value) => {
  if (value) vote.value = sessionEmptyVote(props.majority);
});

/** Show of hands, registered and secret (and assent); the portal in AGETs. */
const methods = computed<VoteMethod[]>(() =>
  VOTE_METHODS.filter(
    (method) =>
      (method !== "portal" || props.context.type === ASSEMBLY_TYPES.AGET) &&
      (method !== "assent" || props.withAssent),
  ),
);
const outcome = computed(() =>
  sessionVoteOutcome(
    vote.value,
    props.context.settings,
    props.context.headcount,
  ),
);
const ready = computed(() =>
  isSessionFinalVoteReady(vote.value, outcome.value),
);
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :description="description"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <div class="space-y-3">
        <SessionVoteFields
          v-model="vote"
          :settings="context.settings"
          :methods="methods"
          :headcount="context.headcount"
          :unanimity="withAssent"
        />
        <p class="text-muted text-xs">
          {{ t("controlSheet.results.notProjected") }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          :label="t('common.cancel')"
          @click="open = false"
        />
        <UButton
          icon="i-lucide-gavel"
          :label="t('session.vote.submit')"
          :loading="busy"
          :disabled="!ready || busy"
          @click="emit('submit', vote)"
        />
      </div>
    </template>
  </UModal>
</template>
