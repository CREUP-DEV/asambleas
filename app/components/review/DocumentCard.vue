<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";

/**
 * A presented document waiting for the Secretaría: what it is, who presents
 * it and since when, with "Validar y publicar" as the main action and
 * "Pedir corrección" next to it. The parent runs both.
 */
const props = withDefaults(
  defineProps<{
    document: DocumentSummaryDto;
    /** Localized path of the document page. */
    to: string;
    /** The action running on this document, if any. */
    busy?: "publish" | "correction" | null;
    /** Another action is running elsewhere: keep the buttons quiet. */
    disabled?: boolean;
  }>(),
  { busy: null, disabled: false },
);

const emit = defineEmits<{ publish: []; correction: [] }>();

const { t, locale } = useI18n();
const now = useAppNow();

const titleId = useId();

const submittedRelative = computed(() =>
  props.document.submittedAt
    ? formatRelative(props.document.submittedAt, {
        locale: locale.value,
        now: now.value,
      })
    : "",
);
const submittedAbsolute = computed(() =>
  formatDateTime(props.document.submittedAt, {
    locale: locale.value,
    style: "long",
  }),
);
</script>

<template>
  <article
    class="border-default bg-default space-y-3 rounded-lg border p-4"
    :aria-labelledby="titleId"
  >
    <div class="space-y-1">
      <h4 :id="titleId" class="text-highlighted font-semibold">
        <NuxtLink
          :to="props.to"
          class="focus-visible:outline-primary rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <UIcon
            :name="
              document.format === 'file'
                ? 'i-lucide-file-text'
                : 'i-lucide-file-pen-line'
            "
            class="text-muted me-1 inline size-4 align-[-2px]"
            aria-hidden="true"
          />{{ document.title }}
        </NuxtLink>
      </h4>
      <p class="text-muted flex flex-wrap items-center gap-x-1.5 text-sm">
        <span>{{ t(`agenda.documentKinds.${document.kind}`) }}</span>
        <template v-if="document.format === 'file'">
          <span aria-hidden="true">·</span>
          <span>{{ t("agenda.formats.file") }}</span>
        </template>
        <template v-if="document.submittedAt">
          <span aria-hidden="true">·</span>
          <span>
            {{ t("review.documents.sent") }}
            <time :datetime="document.submittedAt" :title="submittedAbsolute">{{
              submittedRelative
            }}</time>
          </span>
        </template>
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-2 text-sm">
      <span class="text-muted">{{ t("review.presentedBy") }}</span>
      <CommonMemberBadge
        v-if="document.proponent"
        :member="document.proponent"
        show-name
      />
      <span v-else class="text-dimmed">{{ t("review.noPresenter") }}</span>
    </div>

    <p class="text-muted flex items-start gap-1.5 text-sm">
      <UIcon
        name="i-lucide-eye-off"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span>{{ t("review.documents.waiting") }}</span>
    </p>

    <div class="flex flex-wrap gap-2">
      <UButton
        icon="i-lucide-check-check"
        :label="t('review.documents.publish')"
        :loading="busy === 'publish'"
        :disabled="disabled && busy !== 'publish'"
        @click="emit('publish')"
      />
      <UButton
        color="neutral"
        variant="outline"
        icon="i-lucide-undo-2"
        :label="t('review.askCorrection')"
        :loading="busy === 'correction'"
        :disabled="disabled && busy !== 'correction'"
        @click="emit('correction')"
      />
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-arrow-up-right"
        :label="t('review.documents.open')"
        :to="props.to"
      />
    </div>
  </article>
</template>
