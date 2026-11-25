<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import type { SideRailItem } from "~/components/session/SideRail.vue";
import { provideAmendmentLinks } from "~/composables/amendment/amendmentLinks";
import {
  isSessionDecidable,
  isSessionOpen,
  isSessionTransactable,
  sessionTurnWho,
} from "~/composables/session/sessionModel";
import {
  sessionShortcutNeedsConfirm,
  shortcutKeyIgnoredAt,
} from "~/composables/session/shortcutGuards";
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
 * everything stacks: the debate, the speaking turns, the folded sections,
 * and last the queue, which holds the document's text.
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

// Codes of other amendments in the console preview them and, clicked, bring
// their row into view (user's decision of 2026-11-20).
provideAmendmentLinks({
  get: (id) => session.byId.value.get(id),
  baseOf: () => session.base.value,
  open: (id) => {
    session.focusedId.value = id;
    if (!import.meta.client) return;
    const row = window.document.getElementById(`session-amendment-${id}`);
    row?.scrollIntoView({ block: "center" });
    row?.focus({ preventScroll: true });
  },
});

const assembly = computed(() => session.assembly.value);

useHead(() => ({
  title: assembly.value
    ? t("session.pageTitle", { label: assembly.value.label })
    : t("session.title"),
}));

const isDesktop = useMediaQuery("(min-width: 1024px)");
/** The debate card, which folds into SessionNowBar as the column scrolls. */
const nowCard = ref<HTMLElement | null>(null);

// One line under each folded section's title, so it is useful folded.
const headcountSummary = computed(() => {
  const latest = session.headcounts.latest.value;
  if (!latest) return null;
  return t("session.headcount.summary", {
    present: latest.present,
    eligible: latest.eligible,
    quorum: latest.quorum
      ? t("session.headcount.quorum")
      : t("session.headcount.noQuorum"),
  });
});

const speakersSummary = computed(() => {
  // Until the turns arrive, an empty list would claim nobody asked.
  if (session.speakers.loading.value || session.speakers.unavailable.value) {
    return null;
  }
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
  const id = session.debate.value?.agendaItemId;
  const row = id
    ? session.agendaRows.value.find((other) => other.item.id === id)
    : null;
  return row
    ? numberedAgendaTitle(
        row.number,
        row.item.title,
        t("agenda.unlisted.inText"),
      )
    : null;
});
const previewSummary = computed(() => {
  const current = session.document.value;
  if (!current || current.format !== "structured") return null;
  const count = session.preview.value.applied.length;
  return t("session.preview.applied", { count }, count);
});

/** Who has the floor now, for the folded strip's clock. */
const speaking = computed(() =>
  speakersSummary.value === null ? null : session.speakers.view.value.speaking,
);

/**
 * The side column's strip: one icon per section, with its summary, and
 * folded, what the Mesa watches all along in view without the mouse
 * (E-130): the turns waiting under the microphone (the clock goes in the
 * strip's slot) and a dot for whether the last headcount had quorum.
 */
const sideItems = computed<SideRailItem[]>(() => [
  {
    id: "speakers",
    icon: "i-lucide-mic",
    title: t("session.speakers.title"),
    summary: speakersSummary.value,
    count:
      speakersSummary.value === null
        ? null
        : session.speakers.view.value.waiting.length,
  },
  {
    id: "headcount",
    icon: "i-lucide-users-round",
    title: t("session.headcount.title"),
    summary: headcountSummary.value,
    dot: session.headcounts.latest.value
      ? session.headcounts.latest.value.quorum
        ? "bg-success"
        : "bg-error"
      : null,
  },
  {
    id: "agenda",
    icon: "i-lucide-list-tree",
    title: t("session.agenda.title"),
    summary: agendaSummary.value,
  },
  {
    id: "preview",
    icon: "i-lucide-file-check-2",
    title: t("session.preview.title"),
    summary: previewSummary.value,
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

/** Single-key shortcuts may be off in this browser (WCAG 2.1.4). */
const { enabled: shortcutsEnabled } = useSingleKeyShortcuts();

/**
 * Whether a shortcut must do nothing now: switched off, a dialog of the
 * console open, or the focus in a dialog, a popover or a field (the
 * headcount's checkboxes and the dialogs' close buttons are buttons, which
 * defineShortcuts does not skip).
 */
function shortcutsPaused(): boolean {
  if (!shortcutsEnabled.value) return true;
  if (session.anyDialogOpen.value || !session.canModerate.value) return true;
  return shortcutKeyIgnoredAt(document.activeElement as HTMLElement | null);
}

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
  if (shortcutsPaused()) return;
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
 * tabbed into or reached with j/k, or else the one under debate (the
 * selection follows the debate when it moves on). A held key (auto-repeat)
 * acts once, and nothing is sent while a request for that amendment is
 * still in flight, so a double press never records the same decision twice.
 */
function withFocused(
  event: KeyboardEvent | undefined,
  run: (amendment: AmendmentDto) => void,
): void {
  if (event?.repeat) return;
  if (shortcutsPaused()) return;
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

/**
 * A decision by key ("a", "l") on an amendment that is not the one in
 * debate asks first, naming it: the selection may have stayed on a row
 * while the debate moved on. The console asks it in the same dialog that
 * names a transactional in course over it, if any (confirmSettling), and
 * then runs it on the amendment as it is now, if it still can be decided
 * that way.
 */
function decideByKey(amendment: AmendmentDto, kind: "assent" | "lapse"): void {
  const allowed = kind === "assent" ? isSessionDecidable : isSessionOpen;
  if (!allowed(amendment)) {
    notAvailable(amendment);
    return;
  }
  const options = {
    notDebated: sessionShortcutNeedsConfirm(
      amendment.id,
      session.debate.value?.amendmentId,
    ),
  };
  if (kind === "assent") void session.approve(amendment, "assent", options);
  else void session.lapse(amendment, options);
}

defineShortcuts({
  j: () => move(1),
  k: () => move(-1),
  a: (event?: KeyboardEvent) =>
    withFocused(event, (amendment) => decideByKey(amendment, "assent")),
  v: (event?: KeyboardEvent) =>
    withFocused(event, (amendment) =>
      isSessionDecidable(amendment, session.byId.value)
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
    withFocused(event, (amendment) => decideByKey(amendment, "lapse")),
});
</script>

<template>
  <div class="space-y-3">
    <div v-if="assemblyLoading" class="space-y-3" role="status">
      <span class="sr-only">{{ t("assembly.hub.loading") }}</span>
      <USkeleton aria-hidden="true" class="h-12 w-full" />
      <div class="grid gap-3 lg:grid-cols-[2fr_1fr]">
        <USkeleton aria-hidden="true" class="h-96" />
        <USkeleton aria-hidden="true" class="h-96" />
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
      <!-- Clipped, not hidden: no scroll container of its own, so on a phone
           the bloc bar sticks to the page's bottom and nothing slides it
           sideways (M-075, M-121). -->
      <section
        class="border-default bg-default flex flex-col overflow-clip rounded-xl border lg:h-[calc(100dvh-var(--shell-banner-height,0px)-var(--ui-header-height)-var(--shell-breadcrumb-height,0px)-3rem-var(--shell-session-pill-room,0px))] lg:min-h-[36rem]"
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

        <!-- Wide screens: the debate, and beside it the foldable panels
             folded into a strip that opens on hover (SessionSideRail). -->
        <div v-if="isDesktop" class="relative flex min-h-0 flex-1">
          <div
            class="relative flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-3 sm:p-4"
          >
            <!-- One scroll: the card folds into a bar stuck on top. -->
            <SessionNowBar :target="nowCard" />
            <div ref="nowCard">
              <SessionNowPanel />
            </div>
            <SessionAmendmentQueue />
          </div>

          <SessionSideRail :items="sideItems">
            <template #strip="{ item }">
              <SessionSpeakerTimer
                v-if="item.id === 'speakers' && speaking"
                :started-at="speaking.startedAt"
                :limit-seconds="speaking.limitSeconds"
                class="text-highlighted text-xs font-semibold"
              />
            </template>
            <SessionFoldPanel
              id="speakers"
              :title="t('session.speakers.title')"
              icon="i-lucide-mic"
              :summary="speakersSummary"
            >
              <SessionSpeakersPanel />
            </SessionFoldPanel>
            <SessionFoldPanel
              id="headcount"
              :title="t('session.headcount.title')"
              icon="i-lucide-users-round"
              :summary="headcountSummary"
            >
              <SessionHeadcountPanel />
            </SessionFoldPanel>
            <SessionFoldPanel
              id="agenda"
              :title="t('session.agenda.title')"
              icon="i-lucide-list-tree"
              :summary="agendaSummary"
            >
              <SessionAgendaPanel follow />
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
          </SessionSideRail>
        </div>

        <div v-else class="space-y-3 p-3">
          <!-- Phones and tablets: one column, the debate first, then the
               folded sections, and the queue with the document's text. -->
          <SessionNowPanel />
          <SessionFoldPanel
            id="speakers"
            :title="t('session.speakers.title')"
            icon="i-lucide-mic"
            :summary="speakersSummary"
          >
            <SessionSpeakersPanel />
          </SessionFoldPanel>
          <SessionFoldPanel
            id="headcount"
            :title="t('session.headcount.title')"
            icon="i-lucide-users-round"
            :summary="headcountSummary"
            :default-open="false"
          >
            <SessionHeadcountPanel />
          </SessionFoldPanel>
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
          <!-- The text last: thousands of pixels, it would bury the folded
               sections above (M-076). -->
          <div class="px-1">
            <SessionAmendmentQueue />
          </div>
        </div>
      </section>

      <SessionVoteDialog />
      <SessionAdmissionDialog />
      <SessionRelationDialog />
      <SessionFinalVoteDialog />
      <SessionItemVoteDialog />
      <SessionLapseOfferDialog />
      <SessionWordingDialog />
      <SessionBulkAssentDialog />
      <SessionAlternativesVoteDialog />
      <SessionBlocVoteDialog />
      <SessionTransactionalComposer />

      <template #fallback>
        <div class="space-y-3" role="status">
          <span class="sr-only">{{ t("common.loading") }}</span>
          <USkeleton aria-hidden="true" class="h-12 w-full" />
          <div class="grid gap-3 lg:grid-cols-[2fr_1fr]">
            <USkeleton aria-hidden="true" class="h-96" />
            <USkeleton aria-hidden="true" class="h-96" />
          </div>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>
