<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import type { AmendmentRelationView } from "~/composables/amendment/workspace";

/**
 * One amendment in the workspace list: label, presenting members, kind and
 * change typology, status, admission and proponent position, the late mark,
 * relations and transactional links. The whole card is one button that
 * selects the amendment.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    /** "12 · CEUM 4", or the draft label. */
    label: string;
    labelOf: (id: string) => string;
    relations?: AmendmentRelationView[];
    selected?: boolean;
  }>(),
  { relations: () => [], selected: false },
);

const emit = defineEmits<{ select: [id: string] }>();

const { t } = useI18n();

const showAdmission = computed(
  () =>
    props.amendment.status === "submitted" &&
    props.amendment.admission !== "admitted",
);
const showPosition = computed(
  () =>
    props.amendment.position !== null &&
    props.amendment.position.position !== "pending",
);

const sources = computed(() =>
  props.amendment.sourceIds.map((id) => props.labelOf(id)).join(", "),
);
const transactedIn = computed(() =>
  props.amendment.transactionalIds.map((id) => props.labelOf(id)).join(", "),
);

function relationLabel(view: AmendmentRelationView): string {
  const key =
    view.direction === "from"
      ? `amendment.relations.kinds.${view.relation.kind}`
      : `amendment.relations.inverse.${view.relation.kind}`;
  return `${t(key)} ${props.labelOf(view.otherId)}`;
}
</script>

<template>
  <button
    type="button"
    class="group w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-primary)"
    :class="
      selected
        ? 'border-primary bg-primary/5 ring-primary ring-1'
        : 'border-default bg-default hover:bg-elevated/60'
    "
    :aria-current="selected ? 'true' : undefined"
    @click="emit('select', amendment.id)"
  >
    <span class="flex flex-wrap items-center gap-1.5">
      <span class="text-highlighted font-semibold tabular-nums">
        {{ label }}
      </span>
      <CommonMemberBadge
        v-for="author in amendment.authors"
        :key="author.id"
        :member="author"
        size="xs"
      />
      <span class="ms-auto flex flex-wrap items-center gap-1">
        <CommonStatusBadge
          kind="amendment"
          :value="amendment.status"
          size="xs"
        />
      </span>
    </span>

    <span class="mt-2 flex flex-wrap items-center gap-1">
      <UBadge
        color="neutral"
        variant="outline"
        size="xs"
        :label="t(`amendment.kinds.${amendment.kind}`)"
      />
      <UBadge
        v-for="change in amendment.changeKinds"
        :key="change"
        color="neutral"
        variant="soft"
        size="xs"
        :label="t(`amendment.changeKinds.${change}`)"
      />
      <CommonStatusBadge
        v-if="showAdmission"
        kind="admission"
        :value="amendment.admission"
        size="xs"
      />
      <CommonStatusBadge
        v-if="showPosition && amendment.position"
        kind="position"
        :value="amendment.position.position"
        size="xs"
      />
      <UBadge
        v-if="amendment.late"
        color="warning"
        variant="subtle"
        size="xs"
        icon="i-lucide-clock-alert"
        :label="t('amendment.late')"
      />
      <UBadge
        v-if="amendment.globalReplace"
        color="neutral"
        variant="soft"
        size="xs"
        icon="i-lucide-replace-all"
        :label="t('amendment.card.global')"
      />
    </span>

    <span
      v-if="amendment.justification"
      class="text-muted mt-2 line-clamp-2 block text-sm"
    >
      {{ amendment.justification }}
    </span>

    <span
      v-if="relations.length > 0 || sources || transactedIn"
      class="mt-2 flex flex-wrap gap-1"
    >
      <UBadge
        v-if="sources"
        color="secondary"
        variant="soft"
        size="xs"
        icon="i-lucide-git-merge"
        :label="t('amendment.card.sources', { list: sources })"
      />
      <UBadge
        v-if="transactedIn"
        color="secondary"
        variant="soft"
        size="xs"
        icon="i-lucide-git-merge"
        :label="t('amendment.card.transactedIn', { list: transactedIn })"
      />
      <UBadge
        v-for="view in relations"
        :key="view.relation.id"
        :color="view.relation.kind === 'incompatible' ? 'error' : 'info'"
        variant="soft"
        size="xs"
        icon="i-lucide-link-2"
        :label="relationLabel(view)"
      />
    </span>
  </button>
</template>
