<script setup lang="ts">
import type { Majority } from "~~/shared/constants/domain";

/**
 * The rules of a document in one line, for the Secretaría: "Se puede
 * enmendar · Se vota · Mayoría simple". The controls that change them stay
 * folded below; "Cambiar" (shown while they are folded) emits `change` so
 * the form opens them. The click removes the button, so the form moves
 * focus to the trigger of the section it opened.
 */
const props = withDefaults(
  defineProps<{
    amendable: boolean;
    voted: boolean;
    majority: Majority;
    /** The controls are open: no "Cambiar". */
    open?: boolean;
  }>(),
  { open: false },
);

const emit = defineEmits<{ change: [] }>();

const { t } = useI18n();

const summary = computed(() =>
  [
    props.amendable
      ? t("document.rules.amendable")
      : t("document.rules.notAmendable"),
    props.voted ? t("document.rules.voted") : t("document.rules.notVoted"),
    ...(props.voted ? [t(`document.majorities.${props.majority}`)] : []),
  ].join(" · "),
);
</script>

<template>
  <div
    class="border-default flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm"
    data-testid="document-rules-summary"
  >
    <p class="text-default min-w-0">
      <span class="text-muted">{{ t("document.rules.label") }}</span>
      {{ summary }}
    </p>
    <UButton
      v-if="!open"
      color="neutral"
      variant="outline"
      size="xs"
      icon="i-lucide-settings-2"
      :label="t('document.rules.change')"
      :aria-label="t('document.rules.changeLabel')"
      @click="emit('change')"
    />
  </div>
</template>
