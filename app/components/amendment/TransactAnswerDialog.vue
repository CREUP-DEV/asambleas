<script setup lang="ts">
import type { TransactAnswerResult } from "~/composables/amendment/transactAnswer";

/**
 * Asked when someone answers «Propone una transaccional» where the answer
 * is a step towards writing it (user's decision of 2026-11-21): save the
 * answer and go to the workspace's transactional composer with the
 * amendment chosen, or only save the answer, or change nothing. When a
 * transactional over it is already on its way, it says so and offers to
 * open that one, writing another one only as the secondary choice. The
 * Mesa answering for the presenter reads that the transactional will be
 * the Mesa's. Opened through useTransactAnswer (useOverlay): it closes with
 * the choice, or with `cancel` when dismissed.
 */
const props = defineProps<{
  /** The amendment's code, «UGR1». */
  code: string;
  /**
   * The main presenter the Mesa answers for (its spoken name); null when a
   * presenter answers.
   */
  mesaFor: string | null;
  /** The transactionals over it already on their way: id and code. */
  pending: { id: string; label: string }[];
}>();

const emit = defineEmits<{ close: [result: TransactAnswerResult] }>();

const { t } = useI18n();

const first = computed(() => props.pending[0] ?? null);
const title = computed(() =>
  first.value
    ? t("amendment.transactAnswer.pendingTitle")
    : t("amendment.transactAnswer.title"),
);
const description = computed(() => {
  const answer = props.mesaFor
    ? t("amendment.transactAnswer.answerMesa", {
        code: props.code,
        member: props.mesaFor,
      })
    : t("amendment.transactAnswer.answer", { code: props.code });
  const next = first.value
    ? t(
        "amendment.transactAnswer.pending",
        {
          list: props.pending.map((entry) => entry.label).join(", "),
          count: props.pending.length,
        },
        props.pending.length,
      )
    : props.mesaFor
      ? t("amendment.transactAnswer.draftMesa", { code: props.code })
      : t("amendment.transactAnswer.draft", { code: props.code });
  return `${answer} ${next}`;
});
</script>

<template>
  <UModal
    :title="title"
    :description="description"
    :close="{ onClick: () => emit('close', { action: 'cancel' }) }"
  >
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="emit('close', { action: 'cancel' })"
        />
        <UButton
          color="neutral"
          variant="outline"
          :label="t('amendment.transactAnswer.saveOnly')"
          @click="emit('close', { action: 'save' })"
        />
        <template v-if="first">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-git-merge"
            :label="t('amendment.transactAnswer.draftAnother')"
            @click="emit('close', { action: 'draft' })"
          />
          <UButton
            icon="i-lucide-arrow-right"
            :label="
              t('amendment.transactAnswer.openPending', { code: first.label })
            "
            @click="emit('close', { action: 'open', id: first.id })"
          />
        </template>
        <UButton
          v-else
          icon="i-lucide-git-merge"
          :label="t('amendment.transactAnswer.draftButton')"
          @click="emit('close', { action: 'draft' })"
        />
      </div>
    </template>
  </UModal>
</template>
