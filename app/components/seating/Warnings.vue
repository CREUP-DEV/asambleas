<script setup lang="ts">
import type { SeatingPlanDto } from "~~/shared/types/api";
import type { SeatingWalk } from "~~/shared/utils/seating/runs";
import type { SeatingWarning } from "~~/shared/utils/seating/warnings";

/**
 * The warnings of «Colocar» (docs/seating-plan.md, section 7): what the room
 * still lacks or got wrong (seatingWarnings), worded. Accounts not seated or
 * seated in part are counted here and listed in the tray; split
 * delegations and people the Intranet no longer lists, still on a seat, are
 * named one by one with a way to see them on the plan. Folded until opened;
 * text stays neutral, the colour is on the icon.
 */

const props = defineProps<{
  warnings: readonly SeatingWarning[];
  plan: Pick<SeatingPlanDto, "groups" | "people" | "assignments">;
  walk: SeatingWalk;
}>();

const emit = defineEmits<{ show: [seatIds: string[]] }>();

const { t } = useI18n();
const words = useSeatingWords();

const open = ref(false);

interface Line {
  key: string;
  text: string;
  /** Something to fix (a warning icon), or just worth knowing. */
  serious: boolean;
  seatIds: string[];
}

const groupById = computed(
  () => new Map(props.plan.groups.map((group) => [group.id, group])),
);
const personById = computed(
  () => new Map(props.plan.people.map((person) => [person.id, person])),
);

function seatsOfGroup(groupId: string): string[] {
  const people = new Set(
    props.plan.people
      .filter((person) => person.groupId === groupId)
      .map((person) => person.id),
  );
  return props.plan.assignments
    .filter((entry) => people.has(entry.personId))
    .map((entry) => entry.seatId);
}

const lines = computed<Line[]>(() => {
  const result: Line[] = [];
  let unseated = 0;
  let partly = 0;
  for (const warning of props.warnings) {
    switch (warning.kind) {
      case "group_unseated":
        unseated += 1;
        break;
      case "group_partly_seated":
        partly += 1;
        break;
      default:
        break;
    }
  }
  for (const warning of props.warnings) {
    switch (warning.kind) {
      case "seats_lost":
        result.push({
          key: "lost",
          text: t(
            "seating.warnings.seatsLost",
            { count: warning.personIds.length },
            warning.personIds.length,
          ),
          serious: true,
          seatIds: warning.seatIds,
        });
        break;
      case "seats_short":
        result.push({
          key: "short",
          text: t("seating.warnings.seatsShort", {
            people: warning.people,
            seats: warning.seats,
          }),
          serious: true,
          seatIds: [],
        });
        break;
      case "group_split": {
        const group = groupById.value.get(warning.groupId);
        result.push({
          key: `split-${warning.groupId}`,
          text: t("seating.warnings.split", {
            group: group?.acronym ?? "",
            // «2 + 1»: figures and a sign, the same in every language.
            pieces: warning.pieces.join(" + "),
          }),
          serious: true,
          seatIds: seatsOfGroup(warning.groupId),
        });
        break;
      }
      case "gone_seated": {
        const person = personById.value.get(warning.personId);
        const group = groupById.value.get(warning.groupId);
        const who = person ? words.personLabel(person) : "";
        result.push({
          key: `gone-${warning.personId}`,
          text: t("seating.warnings.gone", {
            who: group ? `${who}, ${group.acronym}` : who,
            seat: words.seatName(props.walk, warning.seatId),
          }),
          serious: true,
          seatIds: [warning.seatId],
        });
        break;
      }
      case "seats_spare":
        result.push({
          key: "spare",
          text: t("seating.warnings.seatsSpare", {
            people: warning.people,
            seats: warning.seats,
          }),
          serious: false,
          seatIds: [],
        });
        break;
      default:
        break;
    }
  }
  const counted: Line[] = [];
  if (unseated > 0) {
    counted.push({
      key: "unseated",
      text: t("seating.warnings.unseated", { count: unseated }, unseated),
      serious: true,
      seatIds: [],
    });
  }
  if (partly > 0) {
    counted.push({
      key: "partly",
      text: t("seating.warnings.partly", { count: partly }, partly),
      serious: true,
      seatIds: [],
    });
  }
  // Lost seats and missing seats first, then the counts, then the rest.
  const head = result.filter(
    (line) => line.key === "lost" || line.key === "short",
  );
  const tail = result.filter(
    (line) => line.key !== "lost" && line.key !== "short",
  );
  return [...head, ...counted, ...tail];
});

const serious = computed(
  () => lines.value.filter((line) => line.serious).length,
);
</script>

<template>
  <section
    v-if="lines.length > 0"
    class="border-default rounded-md border"
    :aria-label="t('seating.warnings.title')"
  >
    <button
      type="button"
      class="flex w-full items-center gap-2 px-2.5 py-2 text-start text-sm"
      :aria-expanded="open"
      @click="open = !open"
    >
      <UIcon
        :name="serious > 0 ? 'i-lucide-triangle-alert' : 'i-lucide-info'"
        class="size-4 shrink-0"
        :class="serious > 0 ? 'text-warning' : 'text-muted'"
        aria-hidden="true"
      />
      <span class="text-default flex-1 font-medium">
        {{ t("seating.warnings.title") }}
      </span>
      <span class="text-muted tabular-nums">{{ lines.length }}</span>
      <UIcon
        :name="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        class="text-muted size-4 shrink-0"
        aria-hidden="true"
      />
    </button>
    <ul v-if="open" class="max-h-48 space-y-1 overflow-y-auto px-2.5 pb-2.5">
      <li
        v-for="line in lines"
        :key="line.key"
        class="text-default flex items-start gap-2 text-sm"
      >
        <span class="min-w-0 flex-1 break-words">{{ line.text }}</span>
        <UButton
          v-if="line.seatIds.length > 0"
          color="neutral"
          variant="link"
          size="xs"
          class="shrink-0 px-0"
          :label="t('seating.warnings.show')"
          @click="emit('show', line.seatIds)"
        />
      </li>
    </ul>
  </section>
</template>
