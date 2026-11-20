<script setup lang="ts">
/**
 * «¿Puede corregirla?» in the forms where the Secretaría does not validate
 * an amendment (user's decision of 2026-11-19): «Sí» sends it back to its
 * authors to fix and present again (the default), «No» declares it not
 * admitted, closed with the note. Shared by the inbox's dialog
 * (ReviewCorrectionModal), the amendment's review panel and its
 * «Devolver para corregir» (AmendmentValidationUndo). On a published
 * amendment the «No» says the note shows with it, since everyone who sees
 * it reads its outcome note.
 */
const props = withDefaults(
  defineProps<{
    /** Visible to everyone: its outcome note would be too. */
    published?: boolean;
    disabled?: boolean;
  }>(),
  { published: false, disabled: false },
);

const correctable = defineModel<boolean>({ default: true });

const { t } = useI18n();

const choice = computed({
  get: () => (correctable.value ? "yes" : "no"),
  set: (value: string) => {
    correctable.value = value !== "no";
  },
});

const items = computed(() => [
  {
    value: "yes",
    label: t("amendment.inadmissibleOnReview.yes"),
  },
  {
    value: "no",
    label: t("amendment.inadmissibleOnReview.no"),
    description: props.published
      ? t("amendment.inadmissibleOnReview.noPublished")
      : undefined,
  },
]);
</script>

<template>
  <URadioGroup
    v-model="choice"
    :items="items"
    :legend="t('amendment.inadmissibleOnReview.legend')"
    :disabled="props.disabled"
    size="sm"
  />
</template>
