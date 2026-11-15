<script setup lang="ts">
import type { SeatingPlanDto } from "~~/shared/types/api";
import type { SeatingProposal } from "~~/shared/utils/seating/proposal";

/**
 * «Proponer reparto» (docs/seating-plan.md, section 7): the proposal is
 * drawn on the plan as a ghost, nothing is saved until «Aplicar». It fills
 * only empty seats unless «Rehacer todo» is ticked, which places everyone
 * again, also whoever sits on a free table or a loose chair. The splits it
 * had to make and who is left without a seat are listed.
 */

const props = defineProps<{
  proposal: SeatingProposal;
  plan: Pick<SeatingPlanDto, "groups" | "people" | "assignments">;
  /** Seats whose occupant the proposal changes. */
  changes: number;
  busy: boolean;
}>();

const redoAll = defineModel<boolean>("redoAll", { default: false });

const emit = defineEmits<{
  apply: [];
  discard: [];
  show: [seatIds: string[]];
}>();

const { t } = useI18n();

const groupById = computed(
  () => new Map(props.plan.groups.map((group) => [group.id, group])),
);

function acronym(groupId: string): string {
  return groupById.value.get(groupId)?.acronym ?? "";
}

/** The seats a group takes in the proposal, to point it out. */
function seatsOf(groupId: string): string[] {
  const people = new Set(
    props.plan.people
      .filter((person) => person.groupId === groupId)
      .map((person) => person.id),
  );
  return props.proposal.assignments
    .filter((entry) => people.has(entry.personId))
    .map((entry) => entry.seatId);
}

const unseatedCount = computed(() =>
  props.proposal.unseated.reduce(
    (sum, entry) => sum + entry.personIds.length,
    0,
  ),
);
</script>

<template>
  <section
    class="border-default flex flex-col gap-3 rounded-lg border p-3 lg:min-h-0"
    :aria-label="t('seating.proposal.title')"
  >
    <div class="space-y-1">
      <h3 class="text-highlighted font-semibold">
        {{ t("seating.proposal.title") }}
      </h3>
      <p class="text-muted text-sm">
        {{ t("seating.proposal.description") }}
      </p>
    </div>

    <UCheckbox
      v-model="redoAll"
      :label="t('seating.proposal.redoAll')"
      :description="t('seating.proposal.redoAllHint')"
      :disabled="busy"
    />

    <div
      class="space-y-3 text-sm lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
      aria-live="polite"
    >
      <p class="text-default">
        {{
          changes > 0
            ? t(
                "seating.proposal.placed",
                { count: proposal.placed.length },
                proposal.placed.length,
              )
            : t("seating.proposal.nothing")
        }}
      </p>

      <div v-if="proposal.splits.length > 0" class="space-y-1">
        <h4 class="text-highlighted font-medium">
          {{ t("seating.proposal.splits") }}
        </h4>
        <p class="text-muted text-xs">
          {{ t("seating.proposal.splitsHint") }}
        </p>
        <ul class="space-y-0.5">
          <li
            v-for="split in proposal.splits"
            :key="split.groupId"
            class="text-default flex items-center gap-2"
          >
            <span class="min-w-0 flex-1">
              <!-- «UGR: 2 + 1»: content, figures and signs only -->
              <span class="font-medium">{{ acronym(split.groupId) }}</span>
              <span class="tabular-nums">: {{ split.pieces.join(" + ") }}</span>
            </span>
            <UButton
              color="neutral"
              variant="link"
              size="xs"
              class="shrink-0 px-0"
              :label="t('seating.warnings.show')"
              @click="emit('show', seatsOf(split.groupId))"
            />
          </li>
        </ul>
      </div>

      <div v-if="proposal.unseated.length > 0" class="space-y-1">
        <h4 class="text-highlighted font-medium">
          {{
            t(
              "seating.proposal.unseated",
              { count: unseatedCount },
              unseatedCount,
            )
          }}
        </h4>
        <ul class="space-y-0.5">
          <li
            v-for="entry in proposal.unseated"
            :key="entry.groupId"
            class="text-default"
          >
            <span class="font-medium">{{ acronym(entry.groupId) }}</span>
            <span class="tabular-nums">: {{ entry.personIds.length }}</span>
          </li>
        </ul>
      </div>
    </div>

    <div class="flex flex-wrap justify-end gap-2">
      <UButton
        color="neutral"
        variant="outline"
        :label="t('seating.proposal.discard')"
        :disabled="busy"
        @click="emit('discard')"
      />
      <UButton
        icon="i-lucide-check"
        :label="t('seating.proposal.apply')"
        :loading="busy"
        :disabled="changes === 0"
        @click="emit('apply')"
      />
    </div>
  </section>
</template>
