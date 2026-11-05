<script setup lang="ts">
import {
  ACCEPTED_AMENDMENT_RULES,
  DOCUMENT_KIND_DEFAULTS,
  type AcceptedAmendmentRule,
  type DocumentKind,
} from "~~/shared/constants/domain";

/**
 * What happens to an amendment the main presenter accepts
 * (`acceptedAmendments`): it goes into the text without a vote, or the
 * assembly votes it like the rest. The usual choice for the document's type
 * is marked, so the Secretaría only changes it for a document that differs.
 * Managers only, inside "Opciones avanzadas".
 *
 * Once the document is published (`published`), a line under the choice
 * says that changing it leaves alone the amendments already accepted: the
 * server applies the rule only to the answers given from then on.
 */
const props = withDefaults(
  defineProps<{
    /** The document's type, whose default is marked (none while unknown). */
    kind?: DocumentKind | null;
    /** Published: amendments may have been answered under the current rule. */
    published?: boolean;
    name?: string;
    disabled?: boolean;
  }>(),
  {
    kind: null,
    published: false,
    name: "acceptedAmendments",
    disabled: false,
  },
);

const rule = defineModel<AcceptedAmendmentRule>({ required: true });

const { t } = useI18n();

const usual = computed(() =>
  props.kind ? DOCUMENT_KIND_DEFAULTS[props.kind].acceptedAmendments : null,
);

const items = computed(() =>
  ACCEPTED_AMENDMENT_RULES.map((value) => ({
    label: t(`document.acceptedRule.options.${value}`),
    description: t(`document.acceptedRule.descriptions.${value}`),
    value,
  })),
);
</script>

<template>
  <UFormField
    :name="name"
    :label="t('document.acceptedRule.label')"
    :description="usual ? t('document.acceptedRule.usualHint') : undefined"
    :help="published ? t('document.acceptedRule.publishedNote') : undefined"
  >
    <URadioGroup
      v-model="rule"
      :items="items"
      value-key="value"
      orientation="vertical"
      variant="card"
      :disabled="disabled"
      class="w-full"
    >
      <template #label="{ item }">
        <span class="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          {{ item.label }}
          <UBadge
            v-if="item.value === usual"
            color="neutral"
            variant="soft"
            size="sm"
            :label="t('document.acceptedRule.usual')"
          />
        </span>
      </template>
    </URadioGroup>
  </UFormField>
</template>
