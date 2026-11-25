<script setup lang="ts">
import type {
  DoubleUParams,
  SeatingLayout,
  SeatingTemplate,
} from "~~/shared/utils/seating/layout";
import { seatingWalk } from "~~/shared/utils/seating/runs";
import {
  DEFAULT_DOUBLE_U_PARAMS,
  doubleUCapacity,
  generateSeatingLayout,
} from "~~/shared/utils/seating/templates";
import { seatViews } from "./-model";

/**
 * «Elige la disposición»: what an editor sees while the assembly has no
 * room yet (docs/seating-plan.md, section 7). The Doble U, CREUP's usual
 * room, with its few numbers and a live preview, or Vacía (loose chairs
 * only). The other templates (U, Filas, Islas) come later.
 */

defineProps<{ saving: boolean }>();

const emit = defineEmits<{ create: [layout: SeatingLayout] }>();

const { t } = useI18n();

type Choice = "double_u" | "empty";
const choice = ref<Choice>("double_u");
const params = ref<DoubleUParams>({ ...DEFAULT_DOUBLE_U_PARAMS });
/** The numbers on screen make a room: else «Usar» would save other ones. */
const paramsValid = ref(true);

const template = computed<SeatingTemplate>(() =>
  choice.value === "double_u"
    ? { kind: "double_u", params: { ...params.value } }
    : { kind: "empty", params: {} },
);

/** The preview's ids only key its drawing; the room saved gets real ones. */
function previewIds() {
  let next = 0;
  return () => `preview${String((next += 1)).padStart(17, "0")}`;
}

const preview = computed(() => {
  const layout = generateSeatingLayout(template.value, {
    createId: previewIds(),
  });
  const walk = seatingWalk(layout);
  return {
    layout,
    walk,
    seats: seatViews(layout, walk, { groups: [], people: [], assignments: [] }),
  };
});

const options = computed(() => [
  {
    value: "double_u" as const,
    label: t("seating.gallery.doubleU"),
    description: t("seating.gallery.doubleUHint"),
  },
  {
    value: "empty" as const,
    label: t("seating.gallery.empty"),
    description: t("seating.gallery.emptyHint"),
  },
]);

/**
 * The total beside «Usar»: the numbers last valid (while the ones typed
 * make no room, «Usar» waits and the field at fault says why).
 */
const capacity = computed(() => doubleUCapacity(params.value));

function create(): void {
  if (choice.value === "double_u" && !paramsValid.value) return;
  emit("create", generateSeatingLayout(template.value));
}
</script>

<template>
  <!--
    Below sm only the page pads it (M-099). Below lg the two wrappers of
    the column are `contents`, so the preview comes right after the choice
    of layout and before the numbers (M-097); from lg the column scrolls
    its numbers and keeps the total and «Usar» in view at its foot (E-109).
  -->
  <section
    class="border-default flex flex-col gap-4 sm:rounded-lg sm:border sm:p-4 lg:min-h-0 lg:flex-1 lg:flex-row"
    aria-labelledby="seating-gallery-title"
  >
    <div
      class="contents lg:flex lg:min-h-0 lg:w-96 lg:shrink-0 lg:flex-col lg:gap-3 xl:w-[28rem]"
    >
      <div
        class="contents lg:flex lg:min-h-0 lg:flex-1 lg:flex-col lg:gap-4 lg:overflow-y-auto"
      >
        <div class="space-y-1">
          <h3 id="seating-gallery-title" class="text-highlighted font-semibold">
            {{ t("seating.gallery.title") }}
          </h3>
          <p class="text-muted text-sm">
            {{ t("seating.gallery.description") }}
          </p>
        </div>

        <URadioGroup
          v-model="choice"
          :items="options"
          variant="card"
          :legend="t('seating.gallery.legend')"
        />

        <SeatingDoubleUFields
          v-if="choice === 'double_u'"
          v-model="params"
          v-model:valid="paramsValid"
          :disabled="saving"
          :show-capacity="false"
          class="order-2 lg:order-none"
        />
      </div>

      <div
        class="border-default order-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 lg:order-none lg:shrink-0 lg:border-t lg:pt-3"
      >
        <p
          v-if="choice === 'double_u' && paramsValid"
          class="text-muted text-sm tabular-nums"
        >
          {{ t("seating.doubleU.capacity", { count: capacity }, capacity) }}
        </p>
        <UButton
          icon="i-lucide-check"
          :label="t('seating.gallery.use')"
          :loading="saving"
          :disabled="choice === 'double_u' && !paramsValid"
          class="ms-auto"
          @click="create"
        />
      </div>
    </div>

    <figure
      class="bg-muted/40 border-default relative order-1 flex min-h-64 flex-1 flex-col overflow-hidden rounded-md border lg:order-none"
    >
      <figcaption class="text-muted px-3 pt-2 text-xs">
        {{ t("seating.gallery.preview") }}
      </figcaption>
      <div class="relative min-h-0 flex-1">
        <ClientOnly v-if="preview.layout.tables.length > 0">
          <SeatingPlan
            :layout="preview.layout"
            :walk="preview.walk"
            :seats="preview.seats"
            :label="t('seating.gallery.previewLabel')"
            :interactive="false"
          />
        </ClientOnly>
        <p
          v-else
          class="text-muted flex h-full items-center justify-center p-6 text-center text-sm"
        >
          {{ t("seating.gallery.emptyPreview") }}
        </p>
      </div>
    </figure>
  </section>
</template>
