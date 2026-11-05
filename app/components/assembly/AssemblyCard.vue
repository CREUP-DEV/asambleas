<script setup lang="ts">
import type { AssemblySummaryDto } from "~~/shared/types/api";
import { formatAssemblyDateRange } from "~/composables/assembly/useCurrentAssembly";
import { assemblyPath } from "~/components/shell/Navigation.vue";

/**
 * Summary card of an assembly: label, type, status, dates, place, document
 * count and a countdown to its next milestone. The whole card links to the
 * assembly; the heading link carries the accessible name.
 */
const props = withDefaults(
  defineProps<{
    assembly: AssemblySummaryDto;
    /** Heading level of the label, to fit the page outline. */
    headingLevel?: 2 | 3 | 4;
    /** Emphasises a live assembly. */
    highlight?: boolean;
  }>(),
  { headingLevel: 3, highlight: false },
);

const { t, te, locale } = useI18n();
const localePath = useLocalePath();

const to = computed(() => localePath(assemblyPath(props.assembly.slug)));

const typeName = computed(() => {
  const key = `assemblies.types.${props.assembly.type}`;
  return te(key) ? t(key) : props.assembly.type;
});

/** "14–16 de noviembre de 2026", the same format as the assembly hub. */
const dates = computed(() =>
  formatAssemblyDateRange(
    props.assembly.startDate,
    props.assembly.endDate,
    locale.value,
  ),
);

const isLive = computed(() => props.assembly.status === "in_session");

const milestone = computed(() => props.assembly.nextMilestone);
const milestoneLabel = computed(() =>
  milestone.value ? t(`calendar.milestones.${milestone.value.key}`) : "",
);

const headingTag = computed(() => `h${props.headingLevel}`);
</script>

<template>
  <article
    class="bg-default hover:ring-accented has-[a:focus-visible]:ring-primary relative flex h-full flex-col gap-3 rounded-lg p-4 transition-shadow hover:shadow-sm has-[a:focus-visible]:ring-2 sm:p-5"
    :class="highlight || isLive ? 'ring-success ring-2' : 'ring-default ring'"
  >
    <header class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <component
          :is="headingTag"
          class="text-highlighted text-lg leading-tight font-semibold"
        >
          <NuxtLink
            :to="to"
            class="after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none"
          >
            {{ assembly.label }}
          </NuxtLink>
        </component>
        <p class="text-muted mt-0.5 truncate text-sm">{{ typeName }}</p>
      </div>
      <div class="flex shrink-0 flex-col items-end gap-1">
        <CommonStatusBadge
          kind="assembly"
          :value="assembly.status"
          :icon="isLive ? 'i-lucide-radio' : undefined"
        />
        <UBadge
          v-if="assembly.agendaFinalizedAt"
          :label="t('assemblies.card.agendaFinal')"
          color="neutral"
          variant="outline"
          size="sm"
          icon="i-lucide-lock"
        />
      </div>
    </header>

    <dl class="grid gap-1.5 text-sm">
      <div class="flex items-center gap-2">
        <dt class="sr-only">{{ t("assemblies.card.dates") }}</dt>
        <UIcon
          name="i-lucide-calendar"
          class="text-dimmed size-4 shrink-0"
          aria-hidden="true"
        />
        <dd class="min-w-0">
          <time :datetime="assembly.startDate">{{ dates }}</time>
        </dd>
      </div>
      <div class="flex items-center gap-2">
        <dt class="sr-only">{{ t("assemblies.card.location") }}</dt>
        <UIcon
          name="i-lucide-map-pin"
          class="text-dimmed size-4 shrink-0"
          aria-hidden="true"
        />
        <dd class="min-w-0 truncate">{{ assembly.location }}</dd>
      </div>
      <div class="flex items-center gap-2">
        <dt class="sr-only">{{ t("assemblies.card.documentsLabel") }}</dt>
        <UIcon
          name="i-lucide-files"
          class="text-dimmed size-4 shrink-0"
          aria-hidden="true"
        />
        <dd>
          {{
            t(
              "assemblies.card.documents",
              { count: assembly.documentCount },
              assembly.documentCount,
            )
          }}
        </dd>
      </div>
    </dl>

    <footer
      v-if="milestone"
      class="border-default mt-auto border-t pt-3 text-sm"
    >
      <span class="sr-only">{{ t("assemblies.card.nextMilestone") }}</span>
      <CommonCountdown
        :to="milestone.at"
        :label="milestoneLabel"
        icon="i-lucide-clock"
      />
    </footer>
  </article>
</template>
