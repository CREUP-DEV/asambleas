<script setup lang="ts">
import { isPastDeadline } from "~~/shared/utils/calendar";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AssemblyDto,
  DocumentCapabilities,
  DocumentSummaryDto,
} from "~~/shared/types/api";
import {
  documentAudience,
  isPendingProgress,
} from "~/composables/document/documentProgress";
import {
  documentCoPresenters,
  isDocumentPresenter,
} from "~/composables/document/documentPresenters";
import { toDate } from "~/utils/format";

/**
 * Title block of a document screen: kind and reference, the title, status,
 * who presents it ("Presenta CEUM con UPV", the main presenter first; one
 * presenting it alone by its full name only) and
 * the amendment window countdown. When several members present a document
 * that takes amendments, a calm line says which one answers them
 * (`showAnswerer`; the editor turns it off where its own note already says
 * so to the presenters). The default slot holds the
 * screen's actions (buttons), aligned to the right on wide screens and
 * wrapped under the title on narrow ones.
 *
 * Inside the assembly hub the page h1 is the assembly, so the title is an h2
 * and the assembly label is hidden by default; screens outside the hub
 * (projection, print) pass `:heading-level="1"` and `show-assembly`.
 *
 * Before publication it says where the document stands and what comes next
 * (useDocumentProgress), with the short status as the badge; a published one says
 * "Publicado" to its presenters only. Screens that
 * explain the status themselves pass `:progress="false"`. With `editTo` the
 * presenter of a draft gets a link to its next step.
 *
 * Accepts a DocumentDto or any DocumentSummaryDto.
 */
const props = withDefaults(
  defineProps<{
    document: DocumentSummaryDto;
    assembly: Pick<AssemblyDto, "slug" | "label">;
    /** Show the assembly label (linked to its page) before the kind. */
    showAssembly?: boolean;
    headingLevel?: 1 | 2;
    /** Show the status sentence before publication. */
    progress?: boolean;
    /** The editor of the presenter's draft, for the call to action. */
    editTo?: string | null;
    /** Say which presenter answers the amendments, with co-presenters. */
    showAnswerer?: boolean;
    /** Name the kind above the title (the editor leaves it out). */
    showKind?: boolean;
    /**
     * The reference above the title. The document page leaves the line out:
     * its reading bar and breadcrumb already say where the reader is, and
     * the title follows.
     */
    showReference?: boolean;
    /**
     * Folded while the document is read: the title on one line beside the
     * actions, without the lines under it, so the text takes the room.
     */
    folded?: boolean;
    /**
     * Who presents it, its kind and reference, when it was published and
     * its amendment window behind an icon beside the title (DocumentDetails)
     * instead of a line under it.
     */
    detailsCard?: boolean;
  }>(),
  {
    folded: false,
    detailsCard: false,
    showAssembly: false,
    headingLevel: 2,
    progress: true,
    editTo: null,
    showAnswerer: true,
    showKind: true,
    showReference: true,
  },
);

defineSlots<{
  /** Actions (UButton, menus). */
  default?: () => unknown;
  /** Extra badges after the status and the proponent. */
  badges?: () => unknown;
  /** Before the title, on its line (the folded header's way through). */
  lead?: () => unknown;
}>();

const slots = useSlots();

const { t } = useI18n();
/** Shared client clock: SSR-consistent, ticks every minute. */
const appNow = useAppNow();
const localePath = useLocalePath();

const assemblyPath = computed(() =>
  localePath(`/asambleas/${encodeURIComponent(props.assembly.slug)}`),
);

const kindLabel = computed(() => t(`document.kinds.${props.document.kind}`));

/** What the line above the title holds (none: no line). */
const eyebrow = computed(() =>
  [
    props.showAssembly && "assembly",
    props.showKind && "kind",
    props.showReference && props.document.reference && "reference",
  ].filter(Boolean),
);

// Status --------------------------------------------------------------------

const me = useMe();

/** A full DocumentDto says what the actor can do; a summary does not. */
function capabilities(
  document: DocumentSummaryDto,
): DocumentCapabilities | null {
  return "can" in document
    ? (document as DocumentSummaryDto & { can: DocumentCapabilities }).can
    : null;
}

const audience = computed(() =>
  documentAudience(props.document, {
    memberId: me.member.value?.id,
    manager:
      capabilities(props.document)?.manage ??
      me.can(PERMISSION_KEYS.DOCUMENT_MANAGE),
  }),
);
const status = useDocumentProgress(() => props.document, audience);
const pending = computed(() => isPendingProgress(status.value.state));
const showSentence = computed(() => props.progress && pending.value);
/**
 * "Publicado" tells only its presenters something: to everyone else a
 * document they can read is public by being there. Withdrawn and postponed
 * show to all.
 */
const showStatus = computed(
  () =>
    props.document.status !== "published" ||
    isDocumentPresenter(props.document, me.member.value?.id),
);
const callToAction = computed(() =>
  props.editTo && status.value.actionLabel ? status.value.actionLabel : null,
);

const SENTENCE_COLORS: Record<string, string> = {
  neutral: "text-muted",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
};

/**
 * The main presenter, named apart when it shares the document with others
 * and the document takes amendments (any of them answers them, but it is
 * the document's proponent).
 */
const answerer = computed(() => {
  const document = props.document;
  if (
    !props.showAnswerer ||
    !document.proponent ||
    document.format !== "structured" ||
    !document.amendable ||
    documentCoPresenters(document).length === 0
  ) {
    return null;
  }
  return document.proponent;
});

const amendableText = computed(
  () =>
    props.document.format === "structured" &&
    props.document.amendable &&
    props.document.status === "published",
);

/**
 * Whether the line under the title has anything: with the details in their
 * card, only a status, a countdown or extra badges keep it.
 */
const statusLine = computed(
  () =>
    !props.detailsCard ||
    pending.value ||
    showStatus.value ||
    (windowState.value === "open" && Boolean(closesAt.value)) ||
    (windowState.value === "upcoming" && Boolean(opensAt.value)) ||
    Boolean(slots.badges),
);

/** Anything under the title at all. */
const hasLines = computed(
  () =>
    statusLine.value ||
    (Boolean(answerer.value) && !props.detailsCard) ||
    showSentence.value,
);

const opensAt = computed(() => toDate(props.document.window.opensAt));
const closesAt = computed(() => toDate(props.document.window.closesAt));

/** Bumped when a countdown expires, so the window state is re-evaluated. */
const expiredTick = ref(0);

/**
 * Which countdown (if any) describes the amendment window right now. Same
 * rule as the server's window.open, evaluated on the client clock so it
 * moves on when a countdown expires.
 */
const windowState = computed<"open" | "upcoming" | "closed" | null>(() => {
  void expiredTick.value;
  if (!amendableText.value || props.document.consolidated) return null;
  const now = appNow.value;
  if (opensAt.value && opensAt.value.getTime() > now) return "upcoming";
  if (!closesAt.value) return null;
  return isPastDeadline(closesAt.value, now) ? "closed" : "open";
});
</script>

<template>
  <!-- Folded, the lines under the title stay mounted (their countdowns
       keep ticking), folded away with an animation, and come back as they
       were. -->
  <header
    class="flex flex-col gap-3 sm:flex-row sm:justify-between"
    :class="folded ? 'sm:items-center' : 'sm:items-start'"
  >
    <div class="min-w-0 flex-1">
      <p
        v-if="eyebrow.length > 0"
        v-show="!folded"
        class="text-muted mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
      >
        <template v-if="showAssembly">
          <NuxtLink
            :to="assemblyPath"
            class="hover:text-default focus-visible:outline-primary rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {{ assembly.label }}
          </NuxtLink>
          <span v-if="eyebrow.length > 1" aria-hidden="true">·</span>
        </template>
        <span v-if="showKind">{{ kindLabel }}</span>
        <template v-if="showReference && document.reference">
          <span v-if="showKind" aria-hidden="true">·</span>
          <span class="text-default font-medium tabular-nums">
            <span class="sr-only">{{ t("document.header.reference") }}: </span>
            {{ document.reference }}
          </span>
        </template>
      </p>

      <!-- Unfolded, the details button follows the title's last word, on
           its line (user's decision of 2026-11-20), instead of floating
           beside a title of several lines; folded, the title is one cut
           line with the button after it. -->
      <div
        class="min-w-0"
        :class="
          folded ? 'flex items-center gap-1' : 'flex items-baseline gap-1'
        "
      >
        <slot name="lead" />
        <!-- Unfolded, the wrapper takes the title's size, so the button's
             align-middle centres it on the title's lowercase letters
             (vertical-align reads the parent's x-height). -->
        <div
          class="min-w-0"
          :class="folded ? 'flex items-center gap-1' : 'text-xl sm:text-2xl'"
        >
          <component
            :is="headingLevel === 1 ? 'h1' : 'h2'"
            class="text-highlighted min-w-0 font-semibold motion-safe:transition-[font-size] motion-safe:duration-300"
            :class="
              folded
                ? 'truncate text-lg'
                : 'inline text-xl text-pretty break-words sm:text-2xl'
            "
            :title="folded ? document.title : undefined"
          >
            {{ document.title }}
          </component>
          <span
            v-if="detailsCard"
            class="shrink-0"
            :class="folded ? 'flex' : 'ms-1 inline-flex align-middle'"
          >
            <DocumentDetails :document="document" />
          </span>
        </div>
      </div>

      <CommonCollapse v-if="hasLines" :open="!folded">
        <div class="space-y-1.5 pt-1.5">
          <div v-if="statusLine" class="flex flex-wrap items-center gap-2">
            <UBadge
              v-if="pending"
              :color="status.color"
              variant="subtle"
              size="md"
              :label="status.label"
            />
            <CommonStatusBadge
              v-else-if="showStatus"
              kind="document"
              :value="document.status"
            />
            <DocumentPresenters
              v-if="!detailsCard"
              :document="document"
              labelled
              show-name
            />

            <CommonCountdown
              v-if="windowState === 'open' && closesAt"
              :to="closesAt"
              :label="t('document.header.amendmentsClose')"
              icon="i-lucide-timer"
              dated
              class="text-sm"
              @expired="expiredTick++"
            />
            <CommonCountdown
              v-else-if="windowState === 'upcoming' && opensAt"
              :to="opensAt"
              :label="t('document.header.amendmentsOpen')"
              icon="i-lucide-calendar-clock"
              dated
              class="text-sm"
              @expired="expiredTick++"
            />
            <!-- A closed window says nothing here: the composer warns whoever
             goes to present one that it will be late. -->

            <slot name="badges" />
          </div>

          <!-- Several presenters: which one is the main presenter -->
          <i18n-t
            v-if="answerer && !detailsCard"
            keypath="document.presenters.answers"
            tag="p"
            scope="global"
            class="text-muted text-sm"
            data-testid="document-answerer"
          >
            <!-- By name, as the presenters line above it -->
            <template #member>
              <span class="text-default font-medium">
                {{
                  memberNameRepeatsAcronym(answerer)
                    ? answerer.acronym
                    : answerer.name
                }}
              </span>
            </template>
          </i18n-t>

          <!-- Where it stands and what comes next (before publication) -->
          <div
            v-if="showSentence"
            class="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-0.5"
          >
            <p
              class="flex min-w-0 items-start gap-1.5 text-sm"
              :class="SENTENCE_COLORS[status.color]"
              role="status"
              aria-live="polite"
              data-testid="document-progress"
            >
              <UIcon
                :name="status.icon"
                class="mt-0.5 size-4 shrink-0"
                aria-hidden="true"
              />
              <span class="break-words whitespace-pre-line">
                {{ status.sentence }}
              </span>
            </p>
            <UButton
              v-if="callToAction && editTo"
              :to="editTo"
              size="sm"
              :color="status.state === 'correction' ? 'warning' : 'primary'"
              trailing-icon="i-lucide-arrow-right"
              :label="callToAction"
            />
          </div>
        </div>
      </CommonCollapse>
    </div>

    <div
      v-if="$slots.default"
      class="flex shrink-0 flex-wrap items-center gap-2 sm:max-w-[55%] sm:justify-end"
    >
      <slot />
    </div>
  </header>
</template>
