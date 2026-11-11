<script setup lang="ts">
/**
 * The uploaded PDF of a `file` document. On large screens, in a browser
 * that shows PDFs inline (`navigator.pdfViewerEnabled`), the browser's own
 * viewer is embedded, with the way to open it in a new tab and, when given,
 * one line about it (that it cannot be amended, where its type usually
 * is). A page that offers that way itself, or that has another way to the
 * document, leaves the button out (`openButton: false`), and then the
 * viewer starts right away unless there is a line to say. Elsewhere (phones, where Android does not render
 * a framed PDF and iOS shows only its first page, and before hydration) the
 * card with the button stays.
 *
 * Only `/api/uploads/documents/**` and `/api/uploads/convocations/**` may be
 * framed, and only by the platform
 * (route rules in `nuxt.config.ts`).
 */
const props = withDefaults(
  defineProps<{
    /** The PDF, or null while it has not been uploaded. */
    url: string | null;
    /** The document's title, which names the frame for screen readers. */
    title: string;
    /** The line about the PDF, if any. */
    description?: string;
    /** The card's description while there is none. */
    pendingDescription?: string;
    /** "Abrir en una pestaña nueva" above the embedded viewer. */
    openButton?: boolean;
  }>(),
  {
    description: undefined,
    pendingDescription: undefined,
    openButton: true,
  },
);

const { t } = useI18n();

const wide = useMediaQuery("(min-width: 1024px)");
const inlinePdf = ref(false);
onMounted(() => {
  inlinePdf.value = navigator.pdfViewerEnabled === true;
});

const embedded = computed(
  () => Boolean(props.url) && wide.value && inlinePdf.value,
);
</script>

<template>
  <section
    v-if="embedded && url"
    class="space-y-3"
    :aria-label="t('workspace.text.file')"
    data-testid="document-pdf-viewer"
  >
    <div
      v-if="description || openButton"
      class="flex flex-wrap items-center justify-between gap-3"
    >
      <p v-if="description" class="text-muted flex items-center gap-2 text-sm">
        <UIcon
          name="i-lucide-file-text"
          class="size-4 shrink-0"
          aria-hidden="true"
        />
        {{ description }}
      </p>
      <UButton
        v-if="openButton"
        :to="url"
        external
        target="_blank"
        class="ms-auto"
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-external-link"
        :label="t('workspace.text.openPdfTab')"
      />
    </div>
    <iframe
      :src="url"
      :title="t('workspace.text.pdfFrame', { title })"
      class="border-default bg-elevated block h-[calc(100dvh-var(--shell-banner-height,0px)-19rem)] min-h-[32rem] w-full rounded-lg border"
    />
  </section>

  <CommonEmptyState
    v-else
    icon="i-lucide-file-text"
    :title="t('workspace.text.file')"
    :description="url ? description : (pendingDescription ?? description)"
    variant="outline"
  >
    <template v-if="url" #action>
      <UButton
        :to="url"
        external
        target="_blank"
        icon="i-lucide-external-link"
        :label="t('workspace.text.openPdf')"
      />
    </template>
  </CommonEmptyState>
</template>
