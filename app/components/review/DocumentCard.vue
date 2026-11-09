<script setup lang="ts">
import type { DocumentSummaryDto } from "~~/shared/types/api";

/**
 * A presented document waiting for the Secretaría: what it is, who presents
 * it (the main presenter, then at most two co-presenters before "N más")
 * and since when, with
 * "Validar y publicar" as the main action and "Pedir corrección" next to
 * it. The parent runs both. Every action names the document it acts on
 * through `aria-describedby`, so a list of buttons tells them apart. With
 * `selectable` a checkbox adds it to the bulk validation, and `late` marks
 * one sent after the documents deadline.
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
    /** Sent after the documents deadline (documents_close). */
    late?: boolean;
    /** Show a checkbox to select it for the bulk validation. */
    selectable?: boolean;
    selected?: boolean;
  }>(),
  {
    busy: null,
    disabled: false,
    late: false,
    selectable: false,
    selected: false,
  },
);

const emit = defineEmits<{
  publish: [];
  correction: [];
  select: [selected: boolean];
}>();

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
    <div class="flex items-start gap-3">
      <UCheckbox
        v-if="selectable"
        class="mt-0.5"
        :model-value="selected"
        :disabled="disabled"
        :aria-label="t('review.documents.select', { title: document.title })"
        @update:model-value="emit('select', $event === true)"
      />
      <div class="min-w-0 flex-1 space-y-1">
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
              <time
                :datetime="document.submittedAt"
                :title="submittedAbsolute"
                >{{ submittedRelative }}</time
              >
            </span>
          </template>
          <UBadge
            v-if="late"
            color="warning"
            variant="subtle"
            size="sm"
            icon="i-lucide-clock-alert"
            :label="t('review.documents.late')"
          />
        </p>
        <p v-if="late" class="text-muted text-sm">
          {{ t("review.documents.lateHint") }}
        </p>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span class="text-muted">{{ t("review.presentedBy") }}</span>
      <DocumentPresenters
        v-if="document.proponent"
        :document="document"
        :max-others="2"
        show-name
      />
      <span v-else class="text-dimmed">{{ t("review.noPresenter") }}</span>
    </div>

    <div class="flex flex-wrap gap-2">
      <UButton
        icon="i-lucide-check-check"
        :label="t('review.documents.publish')"
        :aria-describedby="titleId"
        :loading="busy === 'publish'"
        :disabled="disabled && busy !== 'publish'"
        @click="emit('publish')"
      />
      <UButton
        color="neutral"
        variant="outline"
        icon="i-lucide-undo-2"
        :label="t('review.askCorrection')"
        :aria-describedby="titleId"
        :loading="busy === 'correction'"
        :disabled="disabled && busy !== 'correction'"
        @click="emit('correction')"
      />
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-arrow-up-right"
        :label="t('review.documents.open')"
        :aria-describedby="titleId"
        :to="props.to"
      />
    </div>
  </article>
</template>
