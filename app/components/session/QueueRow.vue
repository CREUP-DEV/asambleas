<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import {
  isSessionAwaitingValidation,
  isSessionDebatable,
  type SessionAmendmentStage,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { useSessionStageLabel } from "~/composables/session/useSessionStageLabel";

/**
 * One amendment of the queue, kept to a single line: its code, who presents
 * it and one status. The amendment the Mesa can decide gets one action,
 * "Debatir"; everything else (its changes, the proponent's position, every
 * other action) opens under the row. The row is the anchor the keyboard
 * shortcuts (j/k) and the consolidated text move the focus to.
 */
const props = defineProps<{ amendment: AmendmentDto }>();

const session = useSessionConsoleContext();
const { t } = useI18n();

const id = computed(() => props.amendment.id);
const code = computed(() => session.label(id.value));
const stage = computed(() => session.stageOf(props.amendment));
const debated = computed(
  () => session.liveState.value?.amendmentId === id.value,
);
const focused = computed(() => session.focusedId.value === id.value);
const busy = computed(
  () =>
    Boolean(session.busy.value[id.value]) || Boolean(session.busy.value.live),
);
/**
 * "Debatir" only where it can work: open to a decision, and public or
 * publishable by this actor (the projection shows only public amendments).
 */
const debatable = computed(() => isSessionDebatable(props.amendment));

const open = ref(false);
const detailsId = computed(() => `session-row-${id.value}-details`);

const STAGE_DOT: Record<SessionAmendmentStage, string> = {
  awaiting_proponent: "bg-(--ui-text-dimmed)",
  proponent_rejected: "bg-error",
  awaiting_validation: "bg-(--ui-text-dimmed)",
  correction_requested: "bg-(--ui-text-dimmed)",
  late: "bg-warning",
  acceptances: "bg-warning",
  open: "bg-info",
  approved: "bg-success",
  rejected: "bg-error",
  inadmissible: "bg-error",
  withdrawn: "bg-(--ui-text-dimmed)",
  lapsed: "bg-(--ui-text-dimmed)",
  transacted: "bg-secondary",
  draft: "bg-(--ui-text-dimmed)",
};

const stageText = useSessionStageLabel();
const stageLabel = computed(() => stageText(stage.value));

const authors = computed(() =>
  props.amendment.authors.map((author) => author.acronym).join(", "),
);
const authorNames = computed(() =>
  props.amendment.authors.map((author) => author.name).join(", "),
);

/**
 * Makes the row the target of the shortcuts, except for amendments the
 * Secretaría has not validated: nothing in them can be decided.
 */
function focusRow(): void {
  session.focusedId.value = isSessionAwaitingValidation(props.amendment)
    ? null
    : id.value;
}
</script>

<template>
  <div
    :id="`session-amendment-${amendment.id}`"
    tabindex="-1"
    class="focus-visible:ring-primary rounded-lg border outline-none focus-visible:ring-2"
    :class="[
      debated ? 'border-primary bg-primary/5' : 'border-default bg-default',
      focused ? 'ring-primary/60 ring-2' : '',
    ]"
    :aria-current="debated ? 'true' : undefined"
    :data-stage="stage"
    @click="focusRow"
    @focusin="focusRow"
  >
    <div class="flex min-h-11 items-center gap-1 ps-1 pe-1.5">
      <button
        type="button"
        class="hover:bg-elevated/60 focus-visible:ring-primary flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-start outline-none focus-visible:ring-2"
        :aria-expanded="open"
        :aria-controls="open ? detailsId : undefined"
        :aria-label="
          t('session.queue.rowLabel', {
            code,
            who: authorNames || '-',
            status: stageLabel,
          })
        "
        @click="open = !open"
      >
        <UIcon
          name="i-lucide-chevron-right"
          class="text-dimmed size-4 shrink-0 transition-transform duration-150 motion-reduce:transition-none"
          :class="open ? 'rotate-90' : ''"
          aria-hidden="true"
        />
        <span
          class="text-highlighted min-w-12 shrink-0 font-bold whitespace-nowrap tabular-nums"
          aria-hidden="true"
        >
          {{ code }}
        </span>
        <!-- Who gives way first on a narrow screen, then the status. -->
        <span
          class="text-default min-w-0 flex-1 basis-0 truncate text-sm"
          aria-hidden="true"
        >
          {{ authors }}
        </span>
        <span
          class="text-muted flex min-w-0 items-center gap-1.5 text-xs"
          aria-hidden="true"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :class="STAGE_DOT[stage]"
          />
          <span class="truncate">{{ stageLabel }}</span>
        </span>
      </button>

      <UBadge
        v-if="debated"
        color="primary"
        variant="solid"
        size="sm"
        icon="i-lucide-radio"
        class="shrink-0"
      >
        <span class="hidden sm:inline">{{ t("session.card.inDebate") }}</span>
        <span class="sr-only sm:hidden">{{ t("session.card.inDebate") }}</span>
      </UBadge>
      <UButton
        v-else-if="debatable"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-radio"
        class="shrink-0"
        :aria-label="t('session.queue.debateNamed', { code })"
        :disabled="busy"
        @click.stop="session.requestDebate(amendment)"
      >
        <span class="hidden sm:inline">{{ t("session.queue.debate") }}</span>
      </UButton>
    </div>

    <div
      v-if="open"
      :id="detailsId"
      class="border-default border-t px-3 pt-2 pb-3"
    >
      <SessionAmendmentCard :amendment="amendment" embedded />
    </div>
  </div>
</template>
