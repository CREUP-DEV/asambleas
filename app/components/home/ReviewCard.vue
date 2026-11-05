<script setup lang="ts">
import type { MeWorkReviewDto } from "~~/shared/types/api";
import { assemblyPath } from "~/components/shell/Navigation.vue";

/**
 * The Secretaría's pending review in one assembly: documents and amendments
 * waiting for validation, amendments validated but not public yet, and
 * expected documents past their deadline. Only the non-zero lines show. One
 * button goes to the validation inbox; overdue documents link to tracking.
 */
const props = withDefaults(
  defineProps<{
    review: MeWorkReviewDto;
    /** Card heading; defaults to "Pendiente de revisar en la <assembly>". */
    title?: string;
    headingLevel?: 2 | 3 | 4;
    /** Its button is the screen's primary action (solid); otherwise soft. */
    primary?: boolean;
  }>(),
  { title: undefined, headingLevel: 3, primary: true },
);

const { t } = useI18n();
const localePath = useLocalePath();

const heading = computed(
  () =>
    props.title ??
    t("home.review.title", { assembly: props.review.assembly.label }),
);
const headingTag = computed(() => `h${props.headingLevel}`);

const lines = computed(() =>
  (
    [
      ["documentsToValidate", "i-lucide-file-check"],
      ["amendmentsToValidate", "i-lucide-message-square-diff"],
      ["amendmentsToPublish", "i-lucide-eye-off"],
      ["documentsOverdue", "i-lucide-calendar-x"],
    ] as const
  )
    .map(([key, icon]) => ({ key, icon, count: props.review[key] }))
    .filter((line) => line.count > 0),
);

const toValidate = computed(
  () =>
    props.review.documentsToValidate +
    props.review.amendmentsToValidate +
    props.review.amendmentsToPublish,
);

const validationPath = computed(() =>
  localePath(assemblyPath(props.review.assembly.slug, "validation")),
);
const trackingPath = computed(() =>
  localePath(assemblyPath(props.review.assembly.slug, "tracking")),
);
</script>

<template>
  <UCard
    :ui="{ body: 'p-4 sm:p-5', header: 'p-4 sm:px-5', footer: 'p-4 sm:px-5' }"
  >
    <template #header>
      <component
        :is="headingTag"
        class="text-highlighted flex items-center gap-2 font-semibold"
      >
        <UIcon
          name="i-lucide-clipboard-check"
          class="text-primary size-5 shrink-0"
          aria-hidden="true"
        />
        {{ heading }}
      </component>
    </template>

    <ul class="space-y-2">
      <li
        v-for="line in lines"
        :key="line.key"
        class="flex items-center gap-2 text-sm"
        :class="line.key === 'documentsOverdue' ? 'text-error' : 'text-default'"
      >
        <UIcon :name="line.icon" class="size-4 shrink-0" aria-hidden="true" />
        <span>
          <span class="font-semibold tabular-nums">{{ line.count }}</span>
          {{ t(`home.review.lines.${line.key}`, line.count) }}
        </span>
      </li>
    </ul>

    <template #footer>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <UButton
          v-if="toValidate > 0"
          :to="validationPath"
          icon="i-lucide-clipboard-check"
          :variant="primary ? 'solid' : 'soft'"
          :label="t('home.review.open')"
        />
        <UButton
          v-if="review.documentsOverdue > 0"
          :to="trackingPath"
          :color="toValidate > 0 ? 'neutral' : 'primary'"
          :variant="toValidate > 0 ? 'link' : primary ? 'solid' : 'soft'"
          trailing-icon="i-lucide-arrow-right"
          :label="t('home.review.tracking')"
          :class="toValidate > 0 ? 'px-0' : ''"
        />
      </div>
    </template>
  </UCard>
</template>
