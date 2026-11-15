<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { SeatingGroupDto, SeatingPersonDto } from "~~/shared/types/api";
import type { SeatingLegendKind } from "~~/shared/utils/seating/groups";
import type { SeatingWalk } from "~~/shared/utils/seating/runs";
import {
  SEATING_COLOUR_STYLES,
  personInitials,
  type SeatingPlanView,
} from "./-model";
import {
  TRAY_SECTIONS,
  filterTray,
  personPick,
  trayKinds,
  trayPick,
  traySections,
  type SeatingPick,
  type TrayGroup,
  type TrayPerson,
  type TraySection,
} from "./-placing";

/**
 * The tray of «Colocar» (docs/seating-plan.md, section 7): every group in
 * seating order under «Sin sentar», «En parte» and «Sentados» (folded),
 * with a search and a filter by kind. Tapping a row picks it (its people
 * without a seat, or the whole account to move it); in «Asistentes» a row
 * opens to its people, each picked on its own. Each row's menu adds
 * people, edits and takes them out. Beside the plan on large screens, in a
 * drawer on a phone. The colour is on the rings only; text stays neutral.
 */

const props = defineProps<{
  groups: readonly TrayGroup[];
  walk: SeatingWalk;
  view: SeatingPlanView;
  /** What is being placed now, to mark its row. */
  pick: SeatingPick | null;
  busy: boolean;
  /** The viewer's account, to say «tu cuenta» on a Mesa person linked to it. */
  meId: string | null;
}>();

const emit = defineEmits<{
  /** `keyboard`: chosen with Enter or Space, so the plan takes the focus. */
  pick: [pick: SeatingPick, keyboard: boolean];
  "add-person": [groupId: string | null];
  "add-placeholder": [group: SeatingGroupDto];
  "edit-person": [person: SeatingPersonDto];
  "delete-person": [person: SeatingPersonDto];
  "needs-seat": [person: SeatingPersonDto, value: boolean];
  "edit-group": [group: SeatingGroupDto];
  "delete-group": [group: SeatingGroupDto];
  unseat: [personIds: string[]];
  show: [seatIds: string[]];
  propose: [];
}>();

const { t } = useI18n();
const words = useSeatingWords();

const query = ref("");
const kind = ref<SeatingLegendKind | "all">("all");

const kinds = computed(() => trayKinds(props.groups));
const kindItems = computed(() => [
  { value: "all" as const, label: t("seating.tray.allKinds") },
  ...kinds.value.map((value) => ({ value, label: words.legendLabel(value) })),
]);
// A kind that leaves the room (a live change) lets the filter go.
watch(kinds, (list) => {
  if (kind.value !== "all" && !list.includes(kind.value)) kind.value = "all";
});

const filtered = computed(() =>
  filterTray(props.groups, {
    query: query.value,
    kind: kind.value === "all" ? null : kind.value,
  }),
);
const sections = computed(() => traySections(filtered.value));
const searching = computed(
  () => query.value.trim().length > 0 || kind.value !== "all",
);

/** «Sentados» starts folded; a search opens every section. */
const folded = ref<Record<TraySection, boolean>>({
  unseated: false,
  partly: false,
  seated: true,
});
function sectionOpen(section: TraySection): boolean {
  return searching.value || !folded.value[section];
}

const expanded = ref(new Set<string>());
function isExpanded(entry: TrayGroup): boolean {
  return (
    props.view === "people" &&
    (expanded.value.has(entry.group.id) || (entry.narrowed && searching.value))
  );
}
function toggle(entry: TrayGroup): void {
  const next = new Set(expanded.value);
  if (next.has(entry.group.id)) next.delete(entry.group.id);
  else next.add(entry.group.id);
  expanded.value = next;
}

const sectionKeys: Record<TraySection, string> = {
  unseated: "seating.tray.sections.unseated",
  partly: "seating.tray.sections.partly",
  seated: "seating.tray.sections.seated",
};

// Rows ------------------------------------------------------------------------------

function samePick(pick: SeatingPick | null): boolean {
  const current = props.pick;
  if (!current || !pick) return false;
  return (
    current.groupId === pick.groupId &&
    current.personIds.length === pick.personIds.length &&
    current.personIds.every((id, index) => pick.personIds[index] === id)
  );
}

const groupPicks = computed(
  () =>
    new Map(
      props.groups.map((entry) => [
        entry.group.id,
        trayPick(props.walk, entry),
      ]),
    ),
);

function groupDescription(group: SeatingGroupDto): string | undefined {
  return memberDescription({
    acronym: group.acronym,
    name: words.groupName(group),
    university: group.member?.university ?? null,
  });
}

function groupCountLabel(entry: TrayGroup): string {
  return t("seating.tray.seatedOf", {
    seated: entry.counts.seated,
    total: entry.counts.total,
  });
}

function groupAction(entry: TrayGroup): string {
  const pick = groupPicks.value.get(entry.group.id);
  if (!pick)
    return t("seating.tray.nothingToPlace", { acronym: entry.group.acronym });
  return entry.unseatedIds.length
    ? t(
        "seating.tray.placeGroup",
        { acronym: entry.group.acronym, count: pick.personIds.length },
        pick.personIds.length,
      )
    : t("seating.tray.moveGroup", { acronym: entry.group.acronym });
}

function personState(item: TrayPerson, group: SeatingGroupDto): string {
  if (item.person.goneAt || group.goneAt) {
    return item.seatId
      ? `${t("seating.person.gone")} · ${words.seatName(props.walk, item.seatId)}`
      : t("seating.person.gone");
  }
  if (!item.person.needsSeat) return t("seating.person.noSeat");
  const where = item.seatId
    ? words.seatName(props.walk, item.seatId)
    : t("seating.tray.noSeat");
  return item.person.status === "pending"
    ? `${where} · ${t("seating.person.pendingShort")}`
    : where;
}

function linkNote(person: SeatingPersonDto): string | null {
  if (!person.userId) return null;
  return person.userId === props.meId
    ? t("seating.people.linkedToYou")
    : t("seating.people.linkedToOther");
}

function seatIdsOf(entry: TrayGroup): string[] {
  return entry.people.flatMap((item) => (item.seatId ? [item.seatId] : []));
}

function groupMenu(entry: TrayGroup): DropdownMenuItem[][] {
  const group = entry.group;
  const seatIds = seatIdsOf(entry);
  const add: DropdownMenuItem[] = [
    {
      label: t("seating.tray.addPerson"),
      icon: "i-lucide-user-plus",
      onSelect: () => emit("add-person", group.id),
    },
    {
      label: t("seating.tray.addPlaceholder"),
      icon: "i-lucide-user-round-plus",
      onSelect: () => emit("add-placeholder", group),
    },
  ];
  const seats: DropdownMenuItem[] = seatIds.length
    ? [
        {
          label: t("seating.tray.showOnPlan"),
          icon: "i-lucide-locate",
          onSelect: () => emit("show", seatIds),
        },
        {
          label: t("seating.tray.unseatGroup"),
          icon: "i-lucide-log-out",
          onSelect: () =>
            emit(
              "unseat",
              entry.people
                .filter((item) => item.seatId)
                .map((item) => item.person.id),
            ),
        },
      ]
    : [];
  const own: DropdownMenuItem[] =
    group.source === "manual" && group.kind !== "mesa"
      ? [
          {
            label: t("seating.groups.edit"),
            icon: "i-lucide-pencil",
            onSelect: () => emit("edit-group", group),
          },
          {
            label: t("seating.groups.delete"),
            icon: "i-lucide-trash-2",
            color: "error",
            onSelect: () => emit("delete-group", group),
          },
        ]
      : [];
  return [add, seats, own].filter((items) => items.length > 0);
}

function personMenu(item: TrayPerson): DropdownMenuItem[][] {
  const person = item.person;
  const seats: DropdownMenuItem[] = item.seatId
    ? [
        {
          label: t("seating.tray.showOnPlan"),
          icon: "i-lucide-locate",
          onSelect: () => emit("show", [item.seatId!]),
        },
        {
          label: t("seating.menu.unseat"),
          icon: "i-lucide-log-out",
          onSelect: () => emit("unseat", [person.id]),
        },
      ]
    : [];
  const edit: DropdownMenuItem[] = [
    {
      label: t("seating.people.edit"),
      icon: "i-lucide-pencil",
      onSelect: () => emit("edit-person", person),
    },
    person.needsSeat
      ? {
          label: t("seating.menu.noSeat"),
          icon: "i-lucide-armchair",
          onSelect: () => emit("needs-seat", person, false),
        }
      : {
          label: t("seating.menu.needsSeat"),
          icon: "i-lucide-armchair",
          onSelect: () => emit("needs-seat", person, true),
        },
  ];
  const remove: DropdownMenuItem[] =
    person.source === "intranet"
      ? []
      : [
          {
            label: t("seating.people.delete"),
            icon: "i-lucide-trash-2",
            color: "error",
            onSelect: () => emit("delete-person", person),
          },
        ];
  return [seats, edit, remove].filter((items) => items.length > 0);
}

/** A click a key made (Enter or Space on the button) has no pointer: detail 0. */
const byKeyboard = (event: MouseEvent) => event.detail === 0;

function pickGroup(entry: TrayGroup, event: MouseEvent): void {
  const pick = groupPicks.value.get(entry.group.id);
  if (pick) emit("pick", pick, byKeyboard(event));
}

function pickPerson(item: TrayPerson, event: MouseEvent): void {
  const pick = personPick(item);
  if (pick) emit("pick", pick, byKeyboard(event));
}

const total = computed(() => props.groups.length);
</script>

<template>
  <aside
    class="border-default flex flex-col gap-3 rounded-lg border p-3 lg:min-h-0"
    :aria-label="t('seating.tray.label')"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-highlighted font-semibold">
        {{ t("seating.tray.title") }}
      </h3>
      <div class="flex flex-wrap gap-1.5">
        <UButton
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-user-plus"
          :label="t('seating.tray.addPerson')"
          :disabled="busy"
          @click="emit('add-person', null)"
        />
        <UButton
          size="sm"
          icon="i-lucide-wand-sparkles"
          :label="t('seating.proposal.open')"
          :disabled="busy"
          @click="emit('propose')"
        />
      </div>
    </div>

    <div class="flex flex-wrap gap-2">
      <UInput
        v-model="query"
        icon="i-lucide-search"
        size="sm"
        class="min-w-40 flex-1"
        :placeholder="t('seating.tray.search')"
        :aria-label="t('seating.tray.search')"
        @keydown.esc="query = ''"
      />
      <USelect
        v-if="kinds.length > 1"
        v-model="kind"
        :items="kindItems"
        value-key="value"
        size="sm"
        class="w-40"
        :aria-label="t('seating.tray.kind')"
      />
    </div>

    <slot name="top" />

    <div class="space-y-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
      <p v-if="total === 0" class="text-muted text-sm">
        {{ t("seating.tray.empty") }}
      </p>
      <p v-else-if="filtered.length === 0" class="text-muted text-sm">
        {{ t("seating.tray.noMatches") }}
      </p>

      <template v-for="section in TRAY_SECTIONS" :key="section">
        <section v-if="sections[section].length > 0" class="space-y-1">
          <h4>
            <button
              type="button"
              class="text-muted hover:text-default flex w-full items-center gap-1.5 text-xs font-medium tracking-wide uppercase"
              :aria-expanded="sectionOpen(section)"
              :disabled="searching"
              @click="folded[section] = !folded[section]"
            >
              <UIcon
                :name="
                  sectionOpen(section)
                    ? 'i-lucide-chevron-down'
                    : 'i-lucide-chevron-right'
                "
                class="size-4 shrink-0"
                aria-hidden="true"
              />
              <span>{{ t(sectionKeys[section]) }}</span>
              <span class="tabular-nums">{{ sections[section].length }}</span>
            </button>
          </h4>

          <ul v-if="sectionOpen(section)" class="space-y-0.5">
            <li v-for="entry in sections[section]" :key="entry.group.id">
              <div
                class="flex items-center gap-1 rounded-md"
                :class="
                  samePick(groupPicks.get(entry.group.id) ?? null)
                    ? 'bg-elevated ring-primary ring-2'
                    : 'hover:bg-elevated/60'
                "
              >
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-start disabled:cursor-default"
                  :aria-pressed="
                    samePick(groupPicks.get(entry.group.id) ?? null)
                  "
                  :aria-label="`${groupAction(entry)}. ${groupCountLabel(entry)}`"
                  :disabled="busy || !groupPicks.get(entry.group.id)"
                  @click="pickGroup(entry, $event)"
                >
                  <span
                    class="relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border-2"
                    :style="{
                      background: SEATING_COLOUR_STYLES[entry.colour].tint,
                      borderColor: SEATING_COLOUR_STYLES[entry.colour].ring,
                    }"
                    aria-hidden="true"
                  >
                    <img
                      v-if="entry.group.imageUrl"
                      :src="entry.group.imageUrl"
                      alt=""
                      class="size-full bg-white object-contain"
                    />
                    <span
                      v-else
                      class="text-highlighted text-[0.6rem] leading-none font-semibold"
                      >{{
                        Array.from(entry.group.acronym).slice(0, 4).join("")
                      }}</span
                    >
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="text-highlighted block text-sm font-medium">
                      {{ entry.group.acronym }}
                    </span>
                    <span
                      v-if="groupDescription(entry.group)"
                      class="text-muted block text-xs break-words"
                    >
                      {{ groupDescription(entry.group) }}
                    </span>
                    <span
                      v-if="entry.group.goneAt"
                      class="text-muted block text-xs"
                    >
                      {{ t("seating.person.gone") }}
                    </span>
                    <span
                      v-else-if="entry.counts.pending > 0"
                      class="text-muted block text-xs"
                    >
                      {{
                        t(
                          "seating.tray.pending",
                          { count: entry.counts.pending },
                          entry.counts.pending,
                        )
                      }}
                    </span>
                  </span>
                  <!-- «2/3»: figures and a sign, the same in every language -->
                  <UBadge
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    class="shrink-0 tabular-nums"
                    :label="`${entry.counts.seated}/${entry.counts.total}`"
                    aria-hidden="true"
                  />
                </button>
                <UButton
                  v-if="view === 'people' && entry.people.length > 0"
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  :icon="
                    isExpanded(entry)
                      ? 'i-lucide-chevron-up'
                      : 'i-lucide-chevron-down'
                  "
                  :aria-expanded="isExpanded(entry)"
                  :aria-label="
                    t('seating.tray.showPeople', {
                      acronym: entry.group.acronym,
                    })
                  "
                  @click="toggle(entry)"
                />
                <UDropdownMenu
                  :items="groupMenu(entry)"
                  :content="{ align: 'end' }"
                  :disabled="busy"
                >
                  <UButton
                    color="neutral"
                    variant="ghost"
                    size="xs"
                    icon="i-lucide-ellipsis-vertical"
                    :aria-label="
                      t('seating.tray.groupActions', {
                        acronym: entry.group.acronym,
                      })
                    "
                  />
                </UDropdownMenu>
              </div>

              <ul
                v-if="isExpanded(entry)"
                class="border-default ms-4 mt-0.5 space-y-0.5 border-s ps-2"
              >
                <li
                  v-for="item in entry.people"
                  :key="item.person.id"
                  class="flex items-center gap-1 rounded-md"
                  :class="
                    samePick(personPick(item))
                      ? 'bg-elevated ring-primary ring-2'
                      : 'hover:bg-elevated/60'
                  "
                >
                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-start disabled:cursor-default"
                    :aria-pressed="samePick(personPick(item))"
                    :disabled="busy || !personPick(item)"
                    @click="pickPerson(item, $event)"
                  >
                    <span
                      class="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full border-2"
                      :class="{
                        'border-dashed': item.person.status === 'pending',
                        'opacity-60': !item.counts,
                      }"
                      :style="{
                        background: SEATING_COLOUR_STYLES[entry.colour].tint,
                        borderColor: SEATING_COLOUR_STYLES[entry.colour].ring,
                      }"
                      aria-hidden="true"
                    >
                      <img
                        v-if="item.person.photoUrl"
                        :src="item.person.photoUrl"
                        alt=""
                        class="size-full object-cover"
                      />
                      <span
                        v-else-if="personInitials(item.person)"
                        class="text-highlighted text-[0.6rem] font-semibold"
                        >{{ personInitials(item.person) }}</span
                      >
                      <UIcon
                        v-else
                        name="i-lucide-user-round"
                        class="text-muted size-4"
                      />
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="text-default block text-sm break-words">
                        {{ words.personLabel(item.person) }}
                      </span>
                      <span class="text-muted block text-xs break-words">
                        {{ personState(item, entry.group) }}
                      </span>
                      <span
                        v-if="linkNote(item.person)"
                        class="text-muted block text-xs"
                      >
                        {{ linkNote(item.person) }}
                      </span>
                    </span>
                  </button>
                  <UDropdownMenu
                    :items="personMenu(item)"
                    :content="{ align: 'end' }"
                    :disabled="busy"
                  >
                    <UButton
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      icon="i-lucide-ellipsis-vertical"
                      :aria-label="
                        t('seating.tray.personActions', {
                          name: words.personLabel(item.person),
                        })
                      "
                    />
                  </UDropdownMenu>
                </li>
              </ul>
            </li>
          </ul>
        </section>
      </template>
    </div>
  </aside>
</template>
