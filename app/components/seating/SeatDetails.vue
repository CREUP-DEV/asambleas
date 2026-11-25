<script setup lang="ts">
import type { SeatingWalk } from "~~/shared/utils/seating/runs";
import { SEATING_COLOUR_STYLES, personInitials, type SeatView } from "./-model";

/**
 * A seat's details (docs/seating-plan.md, section 7), in the popover
 * anchored to the seat or, on a phone, a drawer: the seat, who sits there,
 * their account and how their registration stands (Pendiente, Ya no
 * inscrito). The Intranet's modality is not stored by this platform, so it
 * is not shown. Text stays neutral; the account's colour is on the ring.
 */

const props = defineProps<{
  seat: SeatView;
  walk: SeatingWalk;
}>();

const { t } = useI18n();
const { seatName, personLabel, groupName, statusLabel } = useSeatingWords();

const occupant = computed(() => props.seat.occupant);
const group = computed(() => occupant.value?.group ?? null);
const colour = computed(
  () => SEATING_COLOUR_STYLES[occupant.value?.colour ?? "neutral"],
);
const initials = computed(() =>
  occupant.value ? personInitials(occupant.value.person) : null,
);
const gone = computed(() =>
  Boolean(occupant.value?.person.goneAt || group.value?.goneAt),
);
const pending = computed(
  () => !gone.value && occupant.value?.person.status === "pending",
);
</script>

<template>
  <div class="w-72 max-w-full space-y-3 p-1">
    <p class="text-muted text-xs font-medium tracking-wide uppercase">
      {{ seatName(walk, seat.id) }}
    </p>

    <template v-if="occupant">
      <div class="flex items-center gap-3">
        <span
          class="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full border-2"
          :class="{ 'border-dashed': pending }"
          :style="{ background: colour.tint, borderColor: colour.ring }"
          aria-hidden="true"
        >
          <img
            v-if="occupant.person.photoUrl"
            :src="occupant.person.photoUrl"
            alt=""
            class="size-full object-cover"
          />
          <span
            v-else-if="initials"
            class="text-highlighted text-sm font-semibold"
            >{{ initials }}</span
          >
          <UIcon v-else name="i-lucide-user-round" class="text-muted size-6" />
        </span>
        <div class="min-w-0">
          <p class="text-highlighted font-medium break-words">
            {{ personLabel(occupant.person) }}
          </p>
          <p v-if="group" class="text-muted text-sm break-words">
            <span class="text-default font-medium">{{ group.acronym }}</span>
            · {{ groupName(group) }}
          </p>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-1.5">
        <UBadge
          v-if="gone"
          color="error"
          variant="subtle"
          size="md"
          icon="i-lucide-user-x"
          :label="t('seating.person.gone')"
        />
        <UBadge
          v-else-if="pending"
          color="warning"
          variant="subtle"
          size="md"
          icon="i-lucide-clock"
          :label="t('seating.person.pending')"
        />
        <UBadge
          v-else
          color="neutral"
          variant="subtle"
          size="md"
          :label="statusLabel(occupant.person, group)"
        />
      </div>
      <p v-if="gone" class="text-muted text-sm">
        {{ t("seating.details.goneHint") }}
      </p>
    </template>

    <p v-else-if="seat.disabled" class="text-default text-sm">
      {{ t("seating.details.disabled") }}
    </p>
    <p v-else class="text-default text-sm">
      {{ t("seating.details.free") }}
    </p>
  </div>
</template>
