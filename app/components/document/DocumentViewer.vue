<script setup lang="ts">
defineProps<{
  type: "platform" | "pdf";
  content?: string | null;
  fileUrl?: string | null;
  title: string;
}>();

const { t } = useI18n();
</script>

<template>
  <div>
    <div v-if="type === 'platform' && content">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="rich-text prose max-w-none" v-html="content" />
    </div>

    <div v-else-if="type === 'pdf' && fileUrl" class="flex flex-col gap-3">
      <UButton
        :to="fileUrl"
        target="_blank"
        rel="noopener noreferrer"
        icon="i-tabler-file-type-pdf"
        color="neutral"
        variant="outline"
        external
      >
        {{ t("document.viewPdf") }}
      </UButton>
      <iframe
        :src="fileUrl"
        class="w-full rounded-lg border border-default"
        style="min-height: 600px"
        :title="title"
      />
    </div>

    <div v-else class="text-muted py-8 text-center text-sm">
      {{ t("document.noDocuments") }}
    </div>
  </div>
</template>
