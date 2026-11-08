<script setup lang="ts">
import type { AmendmentStatus } from "~~/shared/constants/domain";
import type { AmendmentDto } from "~~/shared/types/api";
import { transactionalGroupSources } from "~/composables/amendment/transactional";
import type {
  AmendmentGroup,
  AmendmentRelationView,
} from "~/composables/amendment/workspace";

/**
 * Amendments in text order, grouped by the passage they act on: totality
 * amendments first, then each overlap cluster ("Mismo pasaje · 3 enmiendas")
 * or single amendment where it falls in the text. A cluster is a named
 * group, not a landmark: two clusters may share a name. Whoever can propose a
 * transactional gets, on a group with two or more amendments that can be
 * combined, a quiet "Combinar en una transaccional" (`transact`).
 */
const props = withDefaults(
  defineProps<{
    groups: AmendmentGroup<AmendmentDto>[];
    selectedId?: string | null;
    labelOf: (id: string) => string;
    relationsOf: (id: string) => AmendmentRelationView[];
    /** The viewer may propose a transactional on this document. */
    canTransact?: boolean;
    /** Status of any amendment of the document, for transactionals. */
    statusOf?: (id: string) => AmendmentStatus | undefined;
    /** Every amendment of the document, for transactional links. */
    byId?: ReadonlyMap<string, AmendmentDto>;
    /** Acronym of the document's main presenter, who answers them. */
    presenter?: string | null;
  }>(),
  {
    selectedId: null,
    canTransact: false,
    statusOf: undefined,
    byId: undefined,
    presenter: null,
  },
);

const emit = defineEmits<{
  select: [id: string];
  /** Open the transactional composer on these amendments. */
  transact: [ids: string[]];
}>();

const { t } = useI18n();

/** Per overlap group, the amendments a transactional can combine. */
const groupSources = computed(() => {
  const map = new Map<string, string[]>();
  if (!props.canTransact) return map;
  for (const group of props.groups) {
    if (group.kind !== "overlap") continue;
    const ids = transactionalGroupSources(group.amendments);
    if (ids.length >= 2) map.set(group.key, ids);
  }
  return map;
});

function groupLabel(group: AmendmentGroup<AmendmentDto>): string {
  return group.kind === "overlap"
    ? t(
        "amendment.list.overlapGroup",
        { count: group.amendments.length },
        group.amendments.length,
      )
    : t("amendment.list.totalityGroup");
}
</script>

<template>
  <ul class="flex flex-col gap-3" :aria-label="t('amendment.list.label')">
    <li v-for="group in groups" :key="group.key">
      <div
        v-if="group.kind !== 'single'"
        role="group"
        class="rounded-xl border p-2"
        :class="
          group.kind === 'overlap'
            ? 'border-warning/50 bg-warning/5'
            : 'border-default bg-elevated/40'
        "
        :aria-label="groupLabel(group)"
      >
        <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
          <p
            class="flex items-center gap-1.5 text-xs font-semibold"
            :class="
              group.kind === 'overlap' ? 'text-highlighted' : 'text-muted'
            "
          >
            <UIcon
              :name="
                group.kind === 'overlap'
                  ? 'i-lucide-layers'
                  : 'i-lucide-file-stack'
              "
              class="size-4"
              :class="{ 'text-warning': group.kind === 'overlap' }"
              aria-hidden="true"
            />
            {{ groupLabel(group) }}
          </p>
          <UButton
            v-if="groupSources.has(group.key)"
            class="ms-auto"
            icon="i-lucide-git-merge"
            color="neutral"
            variant="ghost"
            size="xs"
            :label="t('amendment.list.transactGroup')"
            @click="emit('transact', groupSources.get(group.key) ?? [])"
          />
        </div>
        <ul class="flex flex-col gap-2">
          <li v-for="amendment in group.amendments" :key="amendment.id">
            <AmendmentCard
              :amendment="amendment"
              :label="labelOf(amendment.id)"
              :label-of="labelOf"
              :relations="relationsOf(amendment.id)"
              :selected="selectedId === amendment.id"
              :status-of="statusOf"
              :by-id="byId"
              :presenter="presenter"
              @select="emit('select', $event)"
            />
          </li>
        </ul>
      </div>
      <AmendmentCard
        v-else
        :amendment="group.amendments[0]!"
        :label="labelOf(group.amendments[0]!.id)"
        :label-of="labelOf"
        :relations="relationsOf(group.amendments[0]!.id)"
        :selected="selectedId === group.amendments[0]!.id"
        :status-of="statusOf"
        :by-id="byId"
        :presenter="presenter"
        @select="emit('select', $event)"
      />
    </li>
  </ul>
</template>
