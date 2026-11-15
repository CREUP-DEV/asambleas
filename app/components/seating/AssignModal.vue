<script setup lang="ts">
import type { CommandPaletteGroup, CommandPaletteItem } from "@nuxt/ui";
import type { SeatingWalk } from "~~/shared/utils/seating/runs";
import type { TrayGroup } from "./-placing";

/**
 * «Asignar…» of «Lista»: who sits on one seat, chosen from everyone who
 * needs a seat (or has one), by account, with a search. Choosing someone
 * who sits elsewhere moves them; whoever was on the seat takes the one they
 * leave, or goes back to the tray. «Dejar libre» empties it.
 */

const props = defineProps<{
  /** «Asiento 12, U exterior». */
  seatTitle: string;
  /** Who sits there now. */
  currentPersonId: string | null;
  groups: readonly TrayGroup[];
  walk: SeatingWalk;
}>();

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ choose: [personId: string | null] }>();

const { t } = useI18n();
const words = useSeatingWords();

function choose(personId: string | null): void {
  emit("choose", personId);
  open.value = false;
}

const groups = computed<CommandPaletteGroup<CommandPaletteItem>[]>(() => {
  const list: CommandPaletteGroup<CommandPaletteItem>[] = [];
  if (props.currentPersonId) {
    list.push({
      id: "free",
      items: [
        {
          label: t("seating.list.leaveFree"),
          icon: "i-lucide-circle-off",
          onSelect: () => choose(null),
        },
      ],
    });
  }
  for (const entry of props.groups) {
    const items = entry.people
      .filter(
        (item) =>
          (item.counts || item.seatId) &&
          item.person.id !== props.currentPersonId,
      )
      .map((item): CommandPaletteItem => ({
        label: words.personLabel(item.person),
        suffix: entry.group.acronym,
        description: item.seatId
          ? words.seatName(props.walk, item.seatId)
          : t("seating.tray.noSeat"),
        onSelect: () => choose(item.person.id),
      }));
    if (items.length) {
      list.push({ id: entry.group.id, label: entry.group.acronym, items });
    }
  }
  return list;
});
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('seating.list.assignTitle', { seat: seatTitle })"
    :description="t('seating.list.assignDescription')"
  >
    <template #body>
      <UCommandPalette
        :groups="groups"
        :placeholder="t('seating.list.assignSearch')"
        :fuse="{ fuseOptions: { keys: ['label', 'suffix', 'description'] } }"
        class="h-80"
      />
    </template>
  </UModal>
</template>
