<script setup lang="ts">
import type { SeatingLayoutStaleData } from "~~/shared/types/api";
import type {
  DoubleUParams,
  SeatingLayout,
  SeatingTemplate,
} from "~~/shared/utils/seating/layout";
import type { SeatingWalk } from "~~/shared/utils/seating/runs";
import { DEFAULT_DOUBLE_U_PARAMS } from "~~/shared/utils/seating/templates";

/**
 * The side panel of «Editar sala» (docs/seating-plan.md, section 7; phase
 * 4): the template's numbers (a new number regenerates the room keeping
 * its seat ids), loose chairs, disabling a seat (a pillar, an aisle), and
 * «Guardar sala» with the recovery when someone else saved first. Moving
 * and turning tables, landmarks and undo come later (phase 7).
 */

const props = defineProps<{
  draft: SeatingLayout;
  walk: SeatingWalk;
  /** The seat or loose chair chosen on the plan. */
  selectedSeatId: string | null;
  dirty: boolean;
  saving: boolean;
  /** Someone saved the room since this draft started. */
  savedElsewhere: boolean;
  /** Their room, after a save refused as stale. */
  conflict: SeatingLayoutStaleData | null;
  canRegenerate: boolean;
}>();

const emit = defineEmits<{
  regenerate: [template: SeatingTemplate];
  "add-chair": [];
  "remove-chair": [chairId: string];
  "toggle-seat": [seatId: string];
  save: [];
  discard: [];
  "load-theirs": [];
  "keep-mine": [];
}>();

const { t } = useI18n();
const { seatName } = useSeatingWords();

type Kind = "double_u" | "empty";
const kind = computed<Kind | null>(() => {
  const value = props.draft.template.kind;
  return value === "double_u" || value === "empty" ? value : null;
});
const kindItems = computed(() => [
  { value: "double_u" as const, label: t("seating.gallery.doubleU") },
  { value: "empty" as const, label: t("seating.gallery.empty") },
]);

function chooseKind(value: Kind): void {
  if (value === kind.value) return;
  emit(
    "regenerate",
    value === "double_u"
      ? { kind: "double_u", params: { ...DEFAULT_DOUBLE_U_PARAMS } }
      : { kind: "empty", params: {} },
  );
}

const params = computed<DoubleUParams | null>(() =>
  props.draft.template.kind === "double_u" ? props.draft.template.params : null,
);

/** The numbers on screen make a room: else «Guardar» would save other ones. */
const paramsValid = ref(true);

function setParams(next: DoubleUParams): void {
  emit("regenerate", { kind: "double_u", params: { ...next } });
}

const selectedChair = computed(() =>
  props.selectedSeatId
    ? (props.draft.chairs.find((chair) => chair.id === props.selectedSeatId) ??
      null)
    : null,
);
const selectedSeat = computed(() => {
  const id = props.selectedSeatId;
  if (!id || selectedChair.value) return null;
  for (const table of props.draft.tables) {
    const seat = table.seats.find((entry) => entry.id === id);
    if (seat) return seat;
  }
  return null;
});
</script>

<template>
  <aside
    class="border-default flex flex-col gap-4 rounded-lg border p-4 lg:min-h-0 lg:overflow-y-auto"
    :aria-label="t('seating.edit.panelLabel')"
  >
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-highlighted font-semibold">
        {{ t("seating.edit.title") }}
      </h3>
      <span v-if="dirty" class="text-muted text-xs">
        {{ t("seating.edit.unsaved") }}
      </span>
    </div>

    <UAlert
      v-if="conflict"
      color="warning"
      variant="subtle"
      icon="i-lucide-users"
      :title="t('seating.edit.conflictTitle')"
      :description="t('seating.edit.conflictDescription')"
      :actions="[
        {
          label: t('seating.edit.loadTheirs'),
          color: 'neutral',
          variant: 'outline',
          onClick: () => emit('load-theirs'),
        },
        {
          label: t('seating.edit.keepMine'),
          color: 'neutral',
          variant: 'ghost',
          onClick: () => emit('keep-mine'),
        },
      ]"
      role="alert"
    />
    <div
      v-else-if="savedElsewhere"
      class="text-muted flex flex-wrap items-center gap-x-2 text-sm"
      role="status"
    >
      <UIcon name="i-lucide-info" class="size-4 shrink-0" aria-hidden="true" />
      <span>{{ t("seating.edit.savedElsewhere") }}</span>
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        class="px-0"
        :label="t('seating.edit.loadTheirs')"
        @click="emit('load-theirs')"
      />
    </div>

    <!-- The template and its numbers -->
    <section v-if="canRegenerate && kind" class="space-y-3">
      <URadioGroup
        :model-value="kind"
        :items="kindItems"
        orientation="horizontal"
        :legend="t('seating.edit.template')"
        :disabled="saving"
        @update:model-value="(value) => chooseKind(value as Kind)"
      />
      <SeatingDoubleUFields
        v-if="params"
        v-model:valid="paramsValid"
        :model-value="params"
        :disabled="saving"
        compact
        @update:model-value="setParams"
      />
      <p class="text-muted text-xs">{{ t("seating.edit.regenerateHint") }}</p>
    </section>
    <p v-else class="text-muted text-sm">
      {{ t("seating.edit.noGenerator") }}
    </p>

    <USeparator />

    <!-- Loose chairs -->
    <section class="space-y-2">
      <h4 class="text-highlighted text-sm font-medium">
        {{ t("seating.edit.chairsTitle") }}
      </h4>
      <p class="text-muted text-sm">
        {{
          t(
            "seating.edit.chairsCount",
            { count: draft.chairs.length },
            draft.chairs.length,
          )
        }}
      </p>
      <UButton
        color="neutral"
        variant="outline"
        icon="i-lucide-armchair"
        :label="t('seating.edit.addChair')"
        :disabled="saving"
        @click="emit('add-chair')"
      />
    </section>

    <USeparator />

    <!-- What is chosen on the plan -->
    <section class="space-y-2" aria-live="polite">
      <template v-if="selectedChair">
        <p class="text-highlighted text-sm font-medium">
          {{ seatName(walk, selectedChair.id) }}
        </p>
        <p class="text-muted text-sm">{{ t("seating.edit.chairHint") }}</p>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-trash-2"
          :label="t('seating.edit.removeChair')"
          :disabled="saving"
          @click="emit('remove-chair', selectedChair.id)"
        />
      </template>
      <template v-else-if="selectedSeat">
        <p class="text-highlighted text-sm font-medium">
          {{ seatName(walk, selectedSeat.id) }}
        </p>
        <p class="text-muted text-sm">
          {{
            selectedSeat.disabled
              ? t("seating.edit.seatDisabledHint")
              : t("seating.edit.seatHint")
          }}
        </p>
        <UButton
          color="neutral"
          variant="outline"
          :icon="
            selectedSeat.disabled ? 'i-lucide-circle-check' : 'i-lucide-ban'
          "
          :label="
            selectedSeat.disabled
              ? t('seating.edit.enableSeat')
              : t('seating.edit.disableSeat')
          "
          :disabled="saving"
          @click="emit('toggle-seat', selectedSeat.id)"
        />
      </template>
      <p v-else class="text-muted text-sm">
        {{ t("seating.edit.selectHint") }}
      </p>
    </section>

    <div class="mt-auto flex flex-wrap gap-2 pt-2">
      <UButton
        icon="i-lucide-save"
        :label="t('seating.edit.save')"
        :loading="saving"
        :disabled="!dirty || (params !== null && !paramsValid)"
        @click="emit('save')"
      />
      <UButton
        v-if="dirty"
        color="neutral"
        variant="ghost"
        :label="t('seating.edit.discard')"
        :disabled="saving"
        @click="emit('discard')"
      />
    </div>
  </aside>
</template>
