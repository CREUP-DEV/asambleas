<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import {
  isSessionDecidable,
  isSessionOpen,
} from "~/composables/session/sessionModel";
import {
  provideSessionConsole,
  useSessionConsole,
} from "~/composables/session/useSessionConsole";

/**
 * Session console of the Mesa de Moderación: agenda progress, the amendment
 * queue of the document under debate and the live consolidated text, in
 * three resizable panels (tabs on narrow screens). Only for those who can
 * moderate the assembly; everyone else is pointed to the projection.
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
const tab = ref<"agenda" | "queue" | "preview">("queue");
const tabItems = computed(() => [
  {
    label: t("session.agenda.title"),
    icon: "i-lucide-list-tree",
    value: "agenda",
    slot: "agenda" as const,
  },
  {
    label: t("session.queue.title"),
    icon: "i-lucide-list-checks",
    value: "queue",
    slot: "queue" as const,
  },
  {
    label: t("session.preview.title"),
    icon: "i-lucide-file-check-2",
    value: "preview",
    slot: "preview" as const,
  },
]);

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
  if (!isDesktop.value) tab.value = "queue";
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

function withFocused(run: (amendment: AmendmentDto) => void): void {
  if (session.anyDialogOpen.value || !session.canModerate.value) return;
  const amendment = session.focused.value;
  if (!amendment) {
    toast.add({
      id: "session-shortcut-nothing",
      title: t("session.shortcuts.nothingFocused"),
      color: "neutral",
      icon: "i-lucide-info",
    });
    return;
  }
  run(amendment);
}

defineShortcuts({
  j: () => move(1),
  k: () => move(-1),
  a: () =>
    withFocused((amendment) =>
      isSessionDecidable(amendment)
        ? void session.approve(amendment, "assent")
        : notAvailable(amendment),
    ),
  v: () =>
    withFocused((amendment) =>
      isSessionDecidable(amendment)
        ? session.openVote(amendment)
        : notAvailable(amendment),
    ),
  t: () =>
    withFocused((amendment) =>
      isSessionOpen(amendment)
        ? session.openComposer([amendment.id])
        : notAvailable(amendment),
    ),
  l: () =>
    withFocused((amendment) =>
      amendment.status === "submitted"
        ? void session.lapse(amendment)
        : notAvailable(amendment),
    ),
});
</script>

<template>
  <div class="space-y-3">
    <div v-if="assemblyLoading" class="space-y-3" aria-busy="true">
      <USkeleton class="h-12 w-full" />
      <div class="grid gap-3 lg:grid-cols-[1fr_2fr_2fr]">
        <USkeleton class="h-96" />
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
        class="border-default bg-default flex flex-col overflow-hidden rounded-xl border lg:h-[calc(100dvh-var(--ui-header-height)-6.25rem)] lg:min-h-[36rem]"
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

        <UDashboardGroup
          v-if="isDesktop"
          storage-key="session-console"
          class="relative inset-auto min-h-0 flex-1"
        >
          <UDashboardPanel
            id="agenda"
            resizable
            :default-size="22"
            :min-size="15"
            :max-size="35"
            :ui="{ root: 'min-h-0', body: 'gap-3 sm:gap-3 p-3 sm:p-4' }"
          >
            <template #header>
              <UDashboardNavbar
                :title="t('session.agenda.title')"
                icon="i-lucide-list-tree"
                :toggle="false"
              />
            </template>
            <template #body>
              <SessionAgendaPanel />
            </template>
          </UDashboardPanel>

          <UDashboardPanel
            id="queue"
            resizable
            :default-size="42"
            :min-size="28"
            :max-size="60"
            :ui="{ root: 'min-h-0', body: 'gap-3 sm:gap-3 p-3 sm:p-4' }"
          >
            <template #header>
              <UDashboardNavbar
                :title="t('session.queue.title')"
                icon="i-lucide-list-checks"
                :toggle="false"
              />
            </template>
            <template #body>
              <SessionAmendmentQueue />
            </template>
          </UDashboardPanel>

          <UDashboardPanel
            id="preview"
            :ui="{ root: 'min-h-0', body: 'gap-3 sm:gap-3 p-3 sm:p-4' }"
          >
            <template #header>
              <UDashboardNavbar
                :title="t('session.preview.title')"
                icon="i-lucide-file-check-2"
                :toggle="false"
              />
            </template>
            <template #body>
              <SessionConsolidatedPanel />
            </template>
          </UDashboardPanel>
        </UDashboardGroup>

        <UTabs
          v-else
          v-model="tab"
          :items="tabItems"
          class="p-3"
          :ui="{ list: 'w-full', trigger: 'flex-1 min-w-0', content: 'pt-3' }"
        >
          <template #agenda>
            <SessionAgendaPanel />
          </template>
          <template #queue>
            <SessionAmendmentQueue />
          </template>
          <template #preview>
            <SessionConsolidatedPanel />
          </template>
        </UTabs>
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
          <div class="grid gap-3 lg:grid-cols-[1fr_2fr_2fr]">
            <USkeleton class="h-96" />
            <USkeleton class="h-96" />
            <USkeleton class="h-96" />
          </div>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>
