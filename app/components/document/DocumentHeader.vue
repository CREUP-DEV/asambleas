<script setup lang="ts">
import type { AssemblyDto, DocumentSummaryDto } from "~~/shared/types/api";
import { toDate } from "~/utils/format";

/**
 * Title block of a document screen: kind and reference, the title, status,
 * proponent and the amendment window countdown. The default slot holds the
 * screen's actions (buttons), aligned to the right on wide screens and
 * wrapped under the title on narrow ones.
 *
 * Inside the assembly hub the page h1 is the assembly, so the title is an h2
 * and the assembly label is hidden by default; screens outside the hub
 * (projection, print) pass `:heading-level="1"` and `show-assembly`.
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
  }>(),
  { showAssembly: false, headingLevel: 2 },
);

defineSlots<{
  /** Actions (UButton, menus). */
  default?: () => unknown;
  /** Extra badges after the status and the proponent. */
  badges?: () => unknown;
}>();

const { t } = useI18n();
const localePath = useLocalePath();

const assemblyPath = computed(() =>
  localePath(`/asambleas/${encodeURIComponent(props.assembly.slug)}`),
);

const kindLabel = computed(() => t(`document.kinds.${props.document.kind}`));

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
  const now = Date.now();
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
        class="text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm"
      >
        <template v-if="showAssembly">
          <NuxtLink
            :to="assemblyPath"
            class="hover:text-default focus-visible:outline-primary rounded-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {{ assembly.label }}
          </NuxtLink>
          <span aria-hidden="true">·</span>
        </template>
        <span>{{ kindLabel }}</span>
        <template v-if="document.reference">
          <span aria-hidden="true">·</span>
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
        <CommonStatusBadge kind="document" :value="document.status" />
        <UBadge
          v-if="document.format === 'file'"
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-file-text"
          :label="t('document.formats.file')"
        />
        <span
          v-if="document.proponent"
          class="inline-flex min-w-0 items-center gap-1.5"
        >
          <span class="text-muted text-sm">
            {{ t("document.header.proponent") }}
          </span>
          <CommonMemberBadge :member="document.proponent" />
        </span>

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
    </div>

    <div
      v-if="$slots.default"
      class="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end"
    >
      <slot />
    </div>
  </header>
</template>
