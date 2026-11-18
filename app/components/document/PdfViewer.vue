<script setup lang="ts">
/**
 * The uploaded PDF of a `file` document, or the signed convocatoria: its
 * pages drawn by the platform (DocumentPdfPages, with its text and links),
 * on every screen, phones included, with the way to open it in a new tab
 * (to zoom, print or save it) and, when given, one line about it (that it
 * cannot be amended, where its type usually is). A page that offers that
 * way itself leaves the button out (`openButton: false`). While there is no
 * PDF yet, a card says so.
 *
 * The pages scroll with the page, so an element right after this one comes
 * into view only once the whole PDF has been scrolled through.
 */
const props = withDefaults(
  defineProps<{
    /** The PDF, or null while it has not been uploaded. */
    url: string | null;
    /** The document's title, which names the pages for screen readers. */
    title: string;
    /** The line about the PDF, if any. */
    description?: string;
    /** The card's description while there is none. */
    pendingDescription?: string;
    /** "Abrir en una pestaña nueva" above the pages. */
    openButton?: boolean;
  }>(),
  {
    description: undefined,
    pendingDescription: undefined,
    openButton: true,
  },
);

const { t } = useI18n();
</script>

<template>
  <section
    v-if="url"
    class="max-w-4xl space-y-3"
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
    <ClientOnly>
      <DocumentPdfPages :key="url" :url="url" :title="props.title" />
      <template #fallback>
        <USkeleton aria-hidden="true" class="aspect-[1/1.414] w-full" />
      </template>
    </ClientOnly>
  </section>

  <CommonEmptyState
    v-else
    icon="i-lucide-file-text"
    :title="t('workspace.text.file')"
    :description="pendingDescription ?? description"
    variant="outline"
  />
</template>
