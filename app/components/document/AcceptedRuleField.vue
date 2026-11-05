<script setup lang="ts">
import {
  ACCEPTED_AMENDMENT_RULES,
  DOCUMENT_KIND_DEFAULTS,
  type AcceptedAmendmentRule,
  type DocumentKind,
} from "~~/shared/constants/domain";
import { acceptedRuleChange } from "~/composables/document/acceptedRule";

/**
 * What happens to an amendment the main presenter accepts
 * (`acceptedAmendments`): it goes into the text without a vote, or the
 * assembly votes it like the rest. The usual choice for the document's type
 * is marked, so the Secretaría only changes it for a document that differs.
 * Managers only, inside "Opciones avanzadas".
 *
 * Once the document is published (`published`), changing the rule also
 * changes the amendments already answered (docs/api.md "Accepted
 * amendments"): a line under the choice says so, and choosing another rule
 * than the stored one (`stored`) shows what saving will do to them
 * (DocumentAcceptedRuleWarning). After the final vote (`locked`) the choice
 * is shown but no longer changes, with the reason.
 */
const props = withDefaults(
  defineProps<{
    /** The document's type, whose default is marked (none while unknown). */
    kind?: DocumentKind | null;
    /** Published: amendments may have been answered under the stored rule. */
    published?: boolean;
    /** The rule stored on the document, to warn before changing it. */
    stored?: AcceptedAmendmentRule | null;
    /** The document's text is settled: the rule no longer changes. */
    locked?: boolean;
    /** The main presenter's acronym, named in the warning. */
    presenter?: string | null;
    name?: string;
    disabled?: boolean;
  }>(),
  {
    kind: null,
    published: false,
    stored: null,
    locked: false,
    presenter: null,
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

/** The rule saving would switch to, when that changes answered amendments. */
const change = computed(() =>
  acceptedRuleChange({
    published: props.published,
    locked: props.locked,
    stored: props.stored,
    next: rule.value,
  }),
);

const help = computed(() => {
  if (!props.published) return undefined;
  if (props.locked) return t("document.acceptedRule.locked");
  return change.value ? undefined : t("document.acceptedRule.publishedNote");
});
</script>

<template>
  <UFormField
    :name="name"
    :label="t('document.acceptedRule.label')"
    :description="
      usual && !locked ? t('document.acceptedRule.usualHint') : undefined
    "
    :help="help"
  >
    <URadioGroup
      v-model="rule"
      :items="items"
      value-key="value"
      orientation="vertical"
      variant="card"
      :disabled="disabled || locked"
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
    <DocumentAcceptedRuleWarning
      v-if="change"
      :change="change"
      :member="presenter"
      class="mt-3"
    />
  </UFormField>
</template>
