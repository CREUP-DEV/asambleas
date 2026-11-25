<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import {
  isSessionAwaitingValidation,
  isSessionDebatable,
  isSessionUnpublished,
  type SessionAmendmentStage,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { useSessionStageLabel } from "~/composables/session/useSessionStageLabel";
import { amendmentSheetKind } from "~/components/control-sheet/-model";

/**
 * One amendment of the queue, kept to a single line: its code, who presents
 * it, whether it is «De forma» or «De contenido» (as the control sheet's
 * «Tipo», amendmentSheetKind) and one status (which says when the assembly cannot read it yet). The
 * amendment the Mesa can decide gets one action, "Debatir"; everything else
 * (its changes, the proponent's position, every other action) opens under
 * the row. The row is the anchor the keyboard shortcuts (j/k) and the
 * consolidated text move the focus to.
 *
 * While the Mesa selects a bloc («Seleccionar para bloque», user's decision
 * of 2026-11-19), every row it may put in one starts with a checkbox (shift
 * ticks the range from the last one), and those the main presenter has not
 * accepted say «sin aceptar».
 */
const props = defineProps<{ amendment: AmendmentDto }>();

const session = useSessionConsoleContext();
const { t } = useI18n();

const id = computed(() => props.amendment.id);
const code = computed(() => session.label(id.value));
const stage = computed(() => session.stageOf(props.amendment));
const debated = computed(() => session.debate.value?.amendmentId === id.value);
const focused = computed(() => session.focusedId.value === id.value);
const busy = computed(
  () =>
    Boolean(session.busy.value[id.value]) || Boolean(session.busy.value.live),
);
/**
 * "Debatir" only where it can work: open to a decision, and public or
 * publishable by this actor (the projection shows only public amendments).
 * A transactional that can no longer go ahead is only withdrawn.
 */
const debatable = computed(
  () => isSessionDebatable(props.amendment) && stage.value !== "superseded",
);

/** A checkbox of the bloc, while the Mesa selects one. */
const blocSelectable = computed(
  () => session.blocMode.value && session.blocOrder.value.includes(id.value),
);
const inBloc = computed(() => session.blocSelected.value.includes(id.value));
const notAccepted = computed(
  () => blocSelectable.value && props.amendment.position?.position !== "accept",
);
/** The checkbox's click: shift ticks or unticks the range. */
function onBlocClick(event: MouseEvent): void {
  event.stopPropagation();
  session.toggleBloc(id.value, event.shiftKey);
}

const open = ref(false);
const detailsId = computed(() => `session-row-${id.value}-details`);

const STAGE_DOT: Record<SessionAmendmentStage, string> = {
  turned_down: "bg-(--ui-text-dimmed)",
  closed: "bg-(--ui-text-dimmed)",
  superseded: "bg-warning",
  awaiting_authors: "bg-(--ui-text-dimmed)",
  awaiting_validation: "bg-(--ui-text-dimmed)",
  correction_requested: "bg-(--ui-text-dimmed)",
  late: "bg-warning",
  sources_admission: "bg-warning",
  acceptances: "bg-warning",
  open: "bg-info",
  incorporated: "bg-success",
  approved: "bg-success",
  rejected: "bg-error",
  inadmissible: "bg-error",
  withdrawn: "bg-(--ui-text-dimmed)",
  lapsed: "bg-(--ui-text-dimmed)",
  transacted: "bg-secondary",
  draft: "bg-(--ui-text-dimmed)",
};

const stageText = useSessionStageLabel();
const stageLabel = computed(() => stageText(stage.value, props.amendment));
/** Validated but private: the row says so without opening it. */
const unpublished = computed(() => isSessionUnpublished(props.amendment));
const rowStatus = computed(() =>
  unpublished.value
    ? `${stageLabel.value} · ${t("session.card.notPublic")}`
    : stageLabel.value,
);

const authors = computed(() =>
  props.amendment.authors.map((author) => author.acronym).join(", "),
);
const authorNames = computed(() =>
  props.amendment.authors.map((author) => author.name).join(", "),
);
/** «De forma» outlined, «De contenido» filled, in grey as on the sheet. */
const kind = computed(() => amendmentSheetKind(props.amendment));
const kindLabel = computed(() => t(`session.queue.kind.${kind.value}`));

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
      <!-- The checkbox is driven by the selection: the click (with or
           without shift) changes it, the key Space too (a click). Its
           cell is a 44 px target, so a tap beside the box ticks it rather
           than opening the row (M-121). -->
      <span
        v-if="blocSelectable"
        class="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center"
        @click="onBlocClick"
      >
        <UCheckbox
          :model-value="inBloc"
          :aria-label="t('session.bloc.include', { code })"
        />
      </span>
      <button
        type="button"
        class="hover:bg-elevated/60 focus-visible:ring-primary flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-start outline-none focus-visible:ring-2"
        :aria-expanded="open"
        :aria-controls="open ? detailsId : undefined"
        :aria-label="
          t('session.queue.rowLabel', {
            code,
            kind: kindLabel,
            who: authorNames || '-',
            status: rowStatus,
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
        <UBadge
          color="neutral"
          :variant="kind === 'formal' ? 'outline' : 'subtle'"
          size="sm"
          class="shrink-0"
          :label="kindLabel"
          aria-hidden="true"
        />
        <span
          class="text-muted flex min-w-0 items-center gap-1.5 text-xs"
          aria-hidden="true"
        >
          <UIcon
            v-if="unpublished"
            name="i-lucide-eye-off"
            class="size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span
            v-else
            class="size-2 shrink-0 rounded-full"
            :class="STAGE_DOT[stage]"
          />
          <span class="truncate">{{ rowStatus }}</span>
        </span>
      </button>

      <UBadge
        v-if="notAccepted"
        color="neutral"
        variant="outline"
        size="sm"
        class="shrink-0"
        :label="t('session.bloc.notAccepted')"
      />
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
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-radio"
        class="shrink-0"
        :aria-label="t('session.queue.debateNamed', { code })"
        :disabled="busy || !session.inSession.value"
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
