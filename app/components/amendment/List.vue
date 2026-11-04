<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import type {
  AmendmentGroup,
  AmendmentRelationView,
} from "~/composables/amendment/workspace";

/**
 * Amendments in text order, grouped by the passage they act on: totality
 * amendments first, then each overlap cluster ("Mismo pasaje · 3 enmiendas")
 * or single amendment where it falls in the text.
 */
defineProps<{
  groups: AmendmentGroup<AmendmentDto>[];
  selectedId?: string | null;
  labelOf: (id: string) => string;
  relationsOf: (id: string) => AmendmentRelationView[];
}>();

const emit = defineEmits<{ select: [id: string] }>();

const { t } = useI18n();
</script>

<template>
  <ul class="flex flex-col gap-3" :aria-label="t('amendment.list.label')">
    <li v-for="group in groups" :key="group.key">
      <section
        v-if="group.kind !== 'single'"
        class="rounded-xl border p-2"
        :class="
          group.kind === 'overlap'
            ? 'border-warning/50 bg-warning/5'
            : 'border-default bg-elevated/40'
        "
        :aria-label="
          group.kind === 'overlap'
            ? t(
                'amendment.list.overlapGroup',
                { count: group.amendments.length },
                group.amendments.length,
              )
            : t('amendment.list.totalityGroup')
        "
      >
        <p
          class="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold"
          :class="group.kind === 'overlap' ? 'text-warning' : 'text-muted'"
        >
          <UIcon
            :name="
              group.kind === 'overlap'
                ? 'i-lucide-layers'
                : 'i-lucide-file-stack'
            "
            class="size-4"
            aria-hidden="true"
          />
          {{
            group.kind === "overlap"
              ? t(
                  "amendment.list.overlapGroup",
                  { count: group.amendments.length },
                  group.amendments.length,
                )
              : t("amendment.list.totalityGroup")
          }}
        </p>
        <ul class="flex flex-col gap-2">
          <li v-for="amendment in group.amendments" :key="amendment.id">
            <AmendmentCard
              :amendment="amendment"
              :label="labelOf(amendment.id)"
              :label-of="labelOf"
              :relations="relationsOf(amendment.id)"
              :selected="selectedId === amendment.id"
              @select="emit('select', $event)"
            />
          </li>
        </ul>
      </section>
      <AmendmentCard
        v-else
        :amendment="group.amendments[0]!"
        :label="labelOf(group.amendments[0]!.id)"
        :label-of="labelOf"
        :relations="relationsOf(group.amendments[0]!.id)"
        :selected="selectedId === group.amendments[0]!.id"
        @select="emit('select', $event)"
      />
    </li>
  </ul>
</template>
