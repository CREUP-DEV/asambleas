<script setup lang="ts">
import type { SeatingWalk } from "~~/shared/utils/seating/runs";
import type { SeatView } from "./-model";
import { listRuns, type ListRun, type TrayGroup } from "./-placing";

/**
 * «Lista» (docs/seating-plan.md, section 7): the room as text, the
 * accessible equivalent of the plan and the phone's fallback. By seats:
 * each run (the Mesa, each U, the loose chairs) and its tables, each seat
 * with who sits there and, for editors in «Colocar», «Asignar…». While
 * someone picked in the tray is being placed (`picking`), each seat offers
 * «Colocar aquí» instead, as a tap on the plan would place them. By
 * accounts: each account in seating order with its people and their seats.
 */

const props = defineProps<{
  walk: SeatingWalk;
  seats: readonly SeatView[];
  groups: readonly TrayGroup[];
  /** Editors in «Colocar»: each seat offers «Asignar…». */
  canAssign: boolean;
  busy: boolean;
  /** Who is being placed («UGR (3)»), picked in the tray; null otherwise. */
  picking?: string | null;
}>();

const emit = defineEmits<{
  assign: [seatId: string];
  place: [seatId: string];
  cancel: [];
}>();

const { t } = useI18n();
const words = useSeatingWords();

const arrangement = ref<"seats" | "accounts">("seats");
const arrangementItems = computed(() => [
  { value: "seats" as const, label: t("seating.list.bySeats") },
  { value: "accounts" as const, label: t("seating.list.byAccounts") },
]);

const runs = computed(() => listRuns(props.walk, props.seats));

const RUN_KEYS = {
  presiding: "seating.list.runs.presiding",
  outer_u: "seating.list.runs.outerU",
  inner_u: "seating.list.runs.innerU",
  loose: "seating.list.runs.loose",
  other: "seating.list.runs.other",
} as const;

function runTitle(run: ListRun): string {
  return t(RUN_KEYS[run.kind], { ordinal: run.ordinal });
}

function seatState(seat: SeatView): string {
  if (seat.occupant) return words.occupantText(seat.occupant);
  return seat.disabled ? t("seating.seat.disabled") : t("seating.seat.free");
}

function groupDescription(entry: TrayGroup): string | undefined {
  return memberDescription({
    acronym: entry.group.acronym,
    name: words.groupName(entry.group),
    university: entry.group.member?.university ?? null,
  });
}
</script>

<template>
  <div class="flex flex-col gap-3 lg:min-h-0 lg:flex-1">
    <URadioGroup
      v-model="arrangement"
      :items="arrangementItems"
      orientation="horizontal"
      :legend="t('seating.list.arrangement')"
      size="sm"
    />

    <div
      v-if="canAssign && picking"
      class="border-default flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm"
    >
      <UIcon
        name="i-lucide-hand"
        class="text-primary size-4 shrink-0"
        aria-hidden="true"
      />
      <span class="text-default min-w-0 flex-1 break-words">
        <span class="text-highlighted font-medium">
          {{ t("seating.place.picking", { who: picking }) }}
        </span>
        · {{ t("seating.list.pickHint") }}
      </span>
      <UButton
        color="neutral"
        variant="outline"
        size="xs"
        :label="t('common.cancel')"
        @click="emit('cancel')"
      />
    </div>

    <div
      class="border-default space-y-5 rounded-lg border p-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto"
    >
      <template v-if="arrangement === 'seats'">
        <p v-if="runs.length === 0" class="text-muted text-sm">
          {{ t("seating.plan.empty") }}
        </p>
        <section v-for="run in runs" :key="run.id" class="space-y-2">
          <h3 class="text-highlighted font-semibold">{{ runTitle(run) }}</h3>
          <div v-for="table in run.tables" :key="table.key" class="space-y-1">
            <h4 class="text-muted text-xs font-medium tracking-wide uppercase">
              {{
                table.from === table.to
                  ? t("seating.list.seat", { number: table.from })
                  : t("seating.list.seats", {
                      from: table.from,
                      to: table.to,
                    })
              }}
            </h4>
            <ul class="divide-default divide-y">
              <li
                v-for="seat in table.seats"
                :key="seat.id"
                class="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm"
              >
                <span class="text-muted w-32 shrink-0">
                  {{ words.seatName(walk, seat.id) }}
                </span>
                <span
                  class="min-w-0 flex-1 break-words"
                  :class="seat.occupant ? 'text-default' : 'text-muted'"
                >
                  {{ seatState(seat) }}
                </span>
                <UButton
                  v-if="canAssign && picking && !seat.disabled"
                  color="primary"
                  variant="soft"
                  size="xs"
                  icon="i-lucide-arrow-down-to-dot"
                  :label="t('seating.list.placeHere')"
                  :aria-label="
                    t('seating.list.placeHereSeat', {
                      who: picking,
                      seat: words.seatName(walk, seat.id),
                    })
                  "
                  :disabled="busy"
                  @click="emit('place', seat.id)"
                />
                <UButton
                  v-else-if="canAssign && !seat.disabled"
                  color="neutral"
                  variant="outline"
                  size="xs"
                  :label="t('seating.list.assign')"
                  :aria-label="
                    t('seating.list.assignSeat', {
                      seat: words.seatName(walk, seat.id),
                    })
                  "
                  :disabled="busy"
                  @click="emit('assign', seat.id)"
                />
              </li>
            </ul>
          </div>
        </section>
      </template>

      <template v-else>
        <p v-if="groups.length === 0" class="text-muted text-sm">
          {{ t("seating.tray.empty") }}
        </p>
        <section
          v-for="entry in groups"
          :key="entry.group.id"
          class="space-y-1"
        >
          <h3 class="flex flex-wrap items-baseline gap-x-2">
            <span class="text-highlighted font-semibold">
              {{ entry.group.acronym }}
            </span>
            <span
              v-if="groupDescription(entry)"
              class="text-muted text-sm break-words"
            >
              {{ groupDescription(entry) }}
            </span>
            <span class="text-muted text-sm tabular-nums">
              {{
                t("seating.tray.seatedOf", {
                  seated: entry.counts.seated,
                  total: entry.counts.total,
                })
              }}
            </span>
          </h3>
          <ul class="divide-default divide-y">
            <li
              v-for="item in entry.people"
              :key="item.person.id"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm"
            >
              <span class="text-default min-w-0 flex-1 break-words">
                {{ words.personLabel(item.person) }}
              </span>
              <span class="text-muted">
                {{
                  item.seatId
                    ? words.seatName(walk, item.seatId)
                    : !item.counts
                      ? item.person.needsSeat
                        ? t("seating.person.gone")
                        : t("seating.person.noSeat")
                      : t("seating.tray.noSeat")
                }}
              </span>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </div>
</template>
