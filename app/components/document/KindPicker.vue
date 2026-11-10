<script setup lang="ts">
import type { DocumentKind } from "~~/shared/constants/domain";
import {
  cardKindGroups,
  kindCardChoice,
  kindCardValues,
  OTHER_KIND_CHOICE,
  type DocumentKindGroups,
  type KindCardValue,
} from "~/composables/document/documentKinds";

/**
 * The type of a document as cards, for presenters: the types their member
 * usually presents one card each, and a last card "Otro tipo" that shows a
 * searchable list with the rest. Choosing "Otro tipo" keeps the type as it
 * is until one is chosen from the list.
 *
 * Goes inside the form field of the type, which labels the cards; the list
 * of the rest has its own label. The Secretaría keeps a searchable list of
 * every type, which is faster for those who know them.
 */
const props = withDefaults(
  defineProps<{
    /** The types offered (presenterKindGroups). */
    groups: DocumentKindGroups;
    /** Where the names of the types come from. */
    labels?: "agenda.documentKinds" | "document.kinds";
    disabled?: boolean;
  }>(),
  { labels: "document.kinds", disabled: false },
);

const kind = defineModel<DocumentKind | undefined>({ required: true });

const { t } = useI18n();

const groups = computed(() => cardKindGroups(props.groups));

/** "Otro tipo" was chosen and no type of its list yet. */
const otherOpen = ref(false);

// A usual type set from outside (proposed from the agenda item, a reset)
// closes the list of the rest.
watch(kind, (next) => {
  if (!next || groups.value.common.includes(next)) otherOpen.value = false;
});

const choice = computed(() =>
  kindCardChoice(groups.value, kind.value, otherOpen.value),
);

const cards = computed(() =>
  kindCardValues(groups.value).map((value) =>
    value === OTHER_KIND_CHOICE
      ? {
          label: t("document.kindPicker.other"),
          description: t("document.kindPicker.otherDescription"),
          value,
        }
      : { label: t(`${props.labels}.${value}`), value },
  ),
);

function onCard(value: KindCardValue | undefined): void {
  if (!value) return;
  if (value === OTHER_KIND_CHOICE) {
    otherOpen.value = true;
    return;
  }
  otherOpen.value = false;
  kind.value = value;
}

const otherItems = computed(() =>
  groups.value.others.map((value) => ({
    label: t(`${props.labels}.${value}`),
    value,
  })),
);

/** The type shown in the list: only one of the rest. */
const otherKind = computed(() =>
  kind.value && groups.value.others.includes(kind.value)
    ? kind.value
    : undefined,
);

function onOther(value: DocumentKind | undefined): void {
  if (!value) return;
  otherOpen.value = false;
  kind.value = value;
}
</script>

<template>
  <div class="space-y-3">
    <URadioGroup
      :model-value="choice"
      :items="cards"
      value-key="value"
      variant="card"
      :disabled="disabled"
      :ui="{ fieldset: 'grid grid-cols-2 gap-2 sm:grid-cols-3' }"
      class="w-full"
      data-testid="document-kind-cards"
      @update:model-value="onCard"
    />
    <!-- Its own field: the cards keep the label and the errors of the type -->
    <UFormField
      v-if="choice === OTHER_KIND_CHOICE"
      :label="t('document.kindPicker.otherLabel')"
    >
      <USelectMenu
        :model-value="otherKind"
        :items="otherItems"
        value-key="value"
        :disabled="disabled"
        :placeholder="t('agenda.newDocument.kindPlaceholder')"
        :aria-label="
          selectMenuLabel(
            t('document.kindPicker.otherLabel'),
            otherItems,
            otherKind,
            t('agenda.newDocument.kindPlaceholder'),
          )
        "
        :search-input="labelledSearch(t('agenda.newDocument.searchKind'))"
        class="w-full sm:w-80"
        @update:model-value="onOther"
      />
    </UFormField>
  </div>
</template>
