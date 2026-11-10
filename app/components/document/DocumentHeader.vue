<script setup lang="ts">
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
import { documentCoPresenters } from "~/composables/document/documentPresenters";
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
 * (useDocumentProgress), with the short status as the badge. Screens that
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
  }>(),
  {
    showAssembly: false,
    headingLevel: 2,
    progress: true,
    editTo: null,
    showAnswerer: true,
    showKind: true,
  },
);

defineSlots<{
  /** Actions (UButton, menus). */
  default?: () => unknown;
  /** Extra badges after the status and the proponent. */
  badges?: () => unknown;
}>();

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
    props.document.reference && "reference",
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
 * and the document takes amendments (only it accepts or rejects them).
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
  return closesAt.value.getTime() > now ? "open" : "closed";
});
</script>

<template>
  <header
    class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"
  >
    <div class="min-w-0 flex-1 space-y-1.5">
      <p
        v-if="eyebrow.length > 0"
        class="text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
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
        <template v-if="document.reference">
          <span v-if="showKind" aria-hidden="true">·</span>
          <span class="text-default font-medium tabular-nums">
            <span class="sr-only">{{ t("document.header.reference") }}: </span>
            {{ document.reference }}
          </span>
        </template>
      </p>

      <component
        :is="headingLevel === 1 ? 'h1' : 'h2'"
        class="text-highlighted text-xl font-semibold text-pretty break-words sm:text-2xl"
      >
        {{ document.title }}
      </component>

      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          v-if="pending"
          :color="status.color"
          variant="subtle"
          size="sm"
          :label="status.label"
        />
        <CommonStatusBadge v-else kind="document" :value="document.status" />
        <UBadge
          v-if="document.format === 'file'"
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-file-text"
          :label="t('document.formats.file')"
        />
        <DocumentPresenters :document="document" labelled show-name />

        <CommonCountdown
          v-if="windowState === 'open' && closesAt"
          :to="closesAt"
          :label="t('document.header.amendmentsClose')"
          icon="i-lucide-timer"
          class="text-sm"
          @expired="expiredTick++"
        />
        <CommonCountdown
          v-else-if="windowState === 'upcoming' && opensAt"
          :to="opensAt"
          :label="t('document.header.amendmentsOpen')"
          icon="i-lucide-calendar-clock"
          class="text-sm"
          @expired="expiredTick++"
        />
        <UBadge
          v-else-if="windowState === 'closed'"
          color="neutral"
          variant="soft"
          size="sm"
          icon="i-lucide-lock"
          :label="t('document.header.amendmentsClosed')"
        />

        <slot name="badges" />
      </div>

      <!-- Several presenters: which one answers the amendments -->
      <i18n-t
        v-if="answerer"
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

    <div
      v-if="$slots.default"
      class="flex shrink-0 flex-wrap items-center gap-2 sm:max-w-[55%] sm:justify-end"
    >
      <slot />
    </div>
  </header>
</template>
