<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import {
  isSessionDecidable,
  isSessionOpen,
  isSessionTransactable,
  sessionTurnWho,
} from "~/composables/session/sessionModel";
import {
  provideSessionConsole,
  useSessionConsole,
} from "~/composables/session/useSessionConsole";

/**
 * Session console of the Mesa de Moderación, used by several Mesa members
 * at once (Presidencia moderates, Secretaría records results), all live. It
 * leads with what is debated now ("Ahora en debate") and its next step;
 * the amendment queue follows as a compact list. Beside it, foldable: the
 * speaking turns, the agenda and the consolidated text. On narrow screens
 * everything stacks in that order, speaking turns right after the debate.
 * Only for those who can moderate the assembly; everyone else is pointed
 * to the projection.
 */
const route = useRoute();
const { t } = useI18n();
const toast = useToast();
const localePath = useLocalePath();

const param = computed(() => String(route.params.assembly ?? ""));
const session = useSessionConsole(param);
provideSessionConsole(session);

const assembly = computed(() => session.assembly.value);

useHead(() => ({
  title: assembly.value
    ? t("session.pageTitle", { label: assembly.value.label })
    : t("session.title"),
}));

const isDesktop = useMediaQuery("(min-width: 1024px)");

// One line under each folded section's title, so it is useful folded.
const speakersSummary = computed(() => {
  const { speaking, waiting } = session.speakers.view.value;
  const parts = [
    speaking
      ? t("session.speakers.summarySpeaking", {
          who: sessionTurnWho(speaking) ?? t("session.speakers.unnamed"),
        })
      : null,
    waiting.length > 0
      ? t(
          "session.speakers.summaryWaiting",
          { count: waiting.length },
          waiting.length,
        )
      : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0
    ? parts.join(" · ")
    : t("session.speakers.summaryEmpty");
});
const agendaSummary = computed(() => {
  const id = session.liveState.value?.agendaItemId;
  const row = id
    ? session.agendaRows.value.find((other) => other.item.id === id)
    : null;
  return row ? `${row.number}. ${row.item.title}` : null;
});
const previewSummary = computed(() => {
  const current = session.document.value;
  if (!current || current.format !== "structured") return null;
  const count = session.preview.value.applied.length;
  return t("session.preview.applied", { count }, count);
});

const assemblyLoading = computed(
  () => !assembly.value && session.assemblyPending.value,
);
const projectionPath = computed(() =>
  localePath(
    `/proyeccion/${encodeURIComponent(assembly.value?.slug ?? param.value)}`,
  ),
);

// Keyboard shortcuts ----------------------------------------------------------

function focusCard(id: string): void {
  void nextTick(() => {
    const element = document.getElementById(`session-amendment-${id}`);
    if (!element) return;
    const reduceMotion = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    element.focus({ preventScroll: true });
    element.scrollIntoView({
      block: "nearest",
      behavior: reduceMotion ? "auto" : "smooth",
    });
  });
}

function move(step: 1 | -1): void {
  if (session.anyDialogOpen.value || !session.canModerate.value) return;
  const id = session.moveFocus(step);
  if (id) focusCard(id);
}

function notAvailable(amendment: AmendmentDto): void {
  toast.add({
    id: "session-shortcut-unavailable",
    title: t("session.shortcuts.unavailable", {
      code: session.label(amendment.id),
    }),
    color: "neutral",
    icon: "i-lucide-info",
  });
}

/**
 * Runs an action shortcut on the focused amendment: the row last clicked,
 * tabbed into or reached with j/k, or else the one under debate. A held key
 * (auto-repeat) acts once, and nothing is sent while a request for that
 * amendment is still in flight, so a double press never records the same
 * decision twice.
 */
function withFocused(
  event: KeyboardEvent | undefined,
  run: (amendment: AmendmentDto) => void,
): void {
  if (event?.repeat) return;
  if (session.anyDialogOpen.value || !session.canModerate.value) return;
  const amendment = session.focused.value ?? session.debatedAmendment.value;
  if (!amendment) {
    toast.add({
      id: "session-shortcut-nothing",
      title: t("session.shortcuts.nothingFocused"),
      color: "neutral",
      icon: "i-lucide-info",
    });
    return;
  }
  if (session.busy.value[amendment.id]) return;
  run(amendment);
}

defineShortcuts({
  j: () => move(1),
  k: () => move(-1),
  a: (event?: KeyboardEvent) =>
    withFocused(event, (amendment) =>
      isSessionDecidable(amendment)
        ? void session.approve(amendment, "assent")
        : notAvailable(amendment),
    ),
  v: (event?: KeyboardEvent) =>
    withFocused(event, (amendment) =>
      isSessionDecidable(amendment)
        ? session.openVote(amendment)
        : notAvailable(amendment),
    ),
  t: (event?: KeyboardEvent) =>
    withFocused(event, (amendment) =>
      isSessionTransactable(amendment)
        ? session.openComposer([amendment.id])
        : notAvailable(amendment),
    ),
  // Lapsing is a decision: not before the assembly agrees to treat a late
  // amendment, nor before the Secretaría validates it.
  l: (event?: KeyboardEvent) =>
    withFocused(event, (amendment) =>
      isSessionOpen(amendment)
        ? void session.lapse(amendment)
        : notAvailable(amendment),
    ),
});
</script>

<template>
  <div class="space-y-3">
    <div v-if="assemblyLoading" class="space-y-3" aria-busy="true">
      <USkeleton class="h-12 w-full" />
      <div class="grid gap-3 lg:grid-cols-[2fr_1fr]">
        <USkeleton class="h-96" />
        <USkeleton class="h-96" />
      </div>
    </div>

    <CommonEmptyState
      v-else-if="!assembly"
      icon="i-lucide-circle-alert"
      :title="t('session.loadError')"
      :description="t('session.loadErrorHint')"
    >
      <template #action>
        <UButton
          icon="i-lucide-refresh-cw"
          :label="t('session.actions.retry')"
          @click="session.refreshAll()"
        />
      </template>
    </CommonEmptyState>

    <CommonEmptyState
      v-else-if="!assembly.can.moderate"
      icon="i-lucide-lock"
      :title="t('session.forbidden')"
      :description="t('session.forbiddenHint')"
    >
      <template #action>
        <UButton
          :to="projectionPath"
          icon="i-lucide-presentation"
          :label="t('session.toolbar.projection')"
        />
      </template>
    </CommonEmptyState>

    <ClientOnly v-else>
      <section
        class="border-default bg-default flex flex-col overflow-hidden rounded-xl border lg:h-[calc(100dvh-var(--ui-header-height)-3rem)] lg:min-h-[36rem]"
        :aria-label="t('session.title')"
      >
        <SessionConsoleToolbar />
        <div
          v-if="assembly.status !== 'in_session'"
          class="border-default border-b px-4 py-2"
        >
          <UAlert
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('session.notInSession')"
            :description="t('session.notInSessionHint')"
          />
        </div>

        <!-- Wide screens: the debate, and beside it the foldable panels. -->
        <UDashboardGroup
          v-if="isDesktop"
          storage-key="session-console-v2"
          class="relative inset-auto min-h-0 flex-1"
        >
          <UDashboardPanel
            id="session-debate"
            resizable
            :default-size="64"
            :min-size="45"
            :max-size="78"
            :ui="{
              root: 'min-h-0',
              body: 'relative gap-4 sm:gap-4 p-3 sm:p-4',
            }"
          >
            <template #body>
              <SessionNowPanel />
              <SessionAmendmentQueue />
            </template>
          </UDashboardPanel>

          <UDashboardPanel
            id="session-side"
            :ui="{
              root: 'min-h-0',
              body: 'relative gap-3 sm:gap-3 p-3 sm:p-4 bg-elevated/30',
            }"
          >
            <template #body>
              <SessionFoldPanel
                id="speakers"
                :title="t('session.speakers.title')"
                icon="i-lucide-mic"
                :summary="speakersSummary"
              >
                <SessionSpeakersPanel />
              </SessionFoldPanel>
              <SessionFoldPanel
                id="agenda"
                :title="t('session.agenda.title')"
                icon="i-lucide-list-tree"
                :summary="agendaSummary"
              >
                <SessionAgendaPanel />
              </SessionFoldPanel>
              <SessionFoldPanel
                id="preview"
                :title="t('session.preview.title')"
                icon="i-lucide-file-check-2"
                :summary="previewSummary"
                :default-open="false"
              >
                <SessionConsolidatedPanel />
              </SessionFoldPanel>
            </template>
          </UDashboardPanel>
        </UDashboardGroup>

        <!-- Phones and tablets: one column, the debate first. -->
        <div v-else class="space-y-3 p-3">
          <SessionNowPanel />
          <SessionFoldPanel
            id="speakers"
            :title="t('session.speakers.title')"
            icon="i-lucide-mic"
            :summary="speakersSummary"
          >
            <SessionSpeakersPanel />
          </SessionFoldPanel>
          <div class="px-1">
            <SessionAmendmentQueue />
          </div>
          <SessionFoldPanel
            id="agenda"
            :title="t('session.agenda.title')"
            icon="i-lucide-list-tree"
            :summary="agendaSummary"
            :default-open="false"
          >
            <SessionAgendaPanel />
          </SessionFoldPanel>
          <SessionFoldPanel
            id="preview"
            :title="t('session.preview.title')"
            icon="i-lucide-file-check-2"
            :summary="previewSummary"
            :default-open="false"
          >
            <SessionConsolidatedPanel />
          </SessionFoldPanel>
        </div>
      </section>

      <SessionVoteDialog />
      <SessionAdmissionDialog />
      <SessionRelationDialog />
      <SessionFinalVoteDialog />
      <SessionLapseOfferDialog />
      <SessionBulkAssentDialog />
      <SessionTransactionalComposer />

      <template #fallback>
        <div class="space-y-3" aria-busy="true">
          <USkeleton class="h-12 w-full" />
          <div class="grid gap-3 lg:grid-cols-[2fr_1fr]">
            <USkeleton class="h-96" />
            <USkeleton class="h-96" />
          </div>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>
