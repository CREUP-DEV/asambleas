<script setup lang="ts">
import type { AmendmentStatus } from "~~/shared/constants/domain";
import type { AmendmentDto } from "~~/shared/types/api";
import {
  presentsOriginal,
  transactionalGroupSources,
} from "~/composables/amendment/transactional";
import type { AmendmentGroup } from "~/composables/amendment/workspace";

/**
 * Amendments in text order, grouped by the passage they act on: each
 * overlap cluster ("Mismo pasaje · 3 enmiendas") or single amendment where
 * it falls in the text. A cluster is a named
 * group, not a landmark: two clusters may share a name. Whoever can propose a
 * transactional gets, on a group with two or more amendments that can be
 * combined, a quiet "Combinar en una transaccional" (`transact`).
 */
const props = withDefaults(
  defineProps<{
    groups: AmendmentGroup<AmendmentDto>[];
    selectedId?: string | null;
    labelOf: (id: string) => string;
    /** The viewer may propose a transactional on this document. */
    canTransact?: boolean;
    /**
     * It may combine anyone's amendments; otherwise a group needs one of
     * the viewer's own (transactionalProposers, user's decision of
     * 2026-11-20).
     */
    transactAny?: boolean;
    /** Status of any amendment of the document, for transactionals. */
    statusOf?: (id: string) => AmendmentStatus | undefined;
    /**
     * The document's answers are public, so the list goes by answer
     * (shared/utils/amendmentOrder.ts): its label says so.
     */
    byAnswer?: boolean;
  }>(),
  {
    selectedId: null,
    canTransact: false,
    transactAny: true,
    statusOf: undefined,
    byAnswer: false,
  },
);

const emit = defineEmits<{
  select: [id: string];
  /** Open the transactional composer on these amendments. */
  transact: [ids: string[]];
}>();

const { t } = useI18n();
const { member } = useMe();

/** Per overlap group, the amendments a transactional can combine. */
const groupSources = computed(() => {
  const map = new Map<string, string[]>();
  if (!props.canTransact) return map;
  const byId = new Map(
    props.groups.flatMap((group) =>
      group.amendments.map((amendment) => [amendment.id, amendment] as const),
    ),
  );
  const memberId = member.value?.id ?? null;
  for (const group of props.groups) {
    if (group.kind !== "overlap") continue;
    const ids = transactionalGroupSources(group.amendments);
    if (ids.length < 2) continue;
    // Only the parties: one of them must be the viewer's own.
    if (
      !props.transactAny &&
      !ids.some((id) => {
        const amendment = byId.get(id);
        return amendment && presentsOriginal(amendment, memberId, byId);
      })
    ) {
      continue;
    }
    map.set(group.key, ids);
  }
  return map;
});

function groupLabel(group: AmendmentGroup<AmendmentDto>): string {
  return t(
    "amendment.list.overlapGroup",
    { count: group.amendments.length },
    group.amendments.length,
  );
}
</script>

<template>
  <ul
    class="flex flex-col gap-3"
    :aria-label="
      t(byAnswer ? 'amendment.list.labelByAnswer' : 'amendment.list.label')
    "
  >
    <li v-for="group in groups" :key="group.key">
      <div
        v-if="group.kind === 'overlap'"
        role="group"
        class="border-warning/50 bg-warning/5 rounded-xl border p-2"
        :aria-label="groupLabel(group)"
      >
        <div class="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
          <p
            class="text-highlighted flex items-center gap-1.5 text-xs font-semibold"
          >
            <UIcon
              name="i-lucide-layers"
              class="text-warning size-4"
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
              :selected="selectedId === amendment.id"
              :status-of="statusOf"
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
        :selected="selectedId === group.amendments[0]!.id"
        :status-of="statusOf"
        @select="emit('select', $event)"
      />
    </li>
  </ul>
</template>
