<script setup lang="ts">
import type { DocumentFileVersionDto } from "~~/shared/types/api";
import { formatDateTime } from "~/utils/format";

/**
 * The PDFs a published `file` document replaced (GET .../files), for
 * document managers: folded under "Versiones anteriores", each with when and
 * by whom it was uploaded and replaced, and a link that opens it. Shows
 * nothing while the document has none. Reloads when the current file
 * changes, since a replacement adds one.
 */
const props = defineProps<{
  /** "/api/assemblies/{assembly}/documents/{document}" (slugs or ids). */
  documentApi: string;
  /** The current file: a new one means the previous may have been kept. */
  fileUrl: string | null;
}>();

const { t, locale } = useI18n();
const api = useApi();

const versions = ref<DocumentFileVersionDto[]>([]);
const failed = ref(false);
const expanded = ref(false);

async function load(): Promise<void> {
  try {
    versions.value = await api.get<DocumentFileVersionDto[]>(
      `${props.documentApi}/files`,
    );
    failed.value = false;
  } catch {
    failed.value = true;
  }
}

watch(() => [props.documentApi, props.fileUrl], load, { immediate: true });

function when(value: string): string {
  return formatDateTime(value, { locale: locale.value });
}

function uploaded(version: DocumentFileVersionDto): string {
  return version.uploadedBy
    ? t("document.file.versions.uploadedBy", {
        date: when(version.uploadedAt),
        name: version.uploadedBy,
      })
    : t("document.file.versions.uploaded", { date: when(version.uploadedAt) });
}

function replaced(version: DocumentFileVersionDto): string {
  return version.replacedBy
    ? t("document.file.versions.replacedBy", {
        date: when(version.replacedAt),
        name: version.replacedBy,
      })
    : t("document.file.versions.replaced", { date: when(version.replacedAt) });
}
</script>

<template>
  <section
    v-if="versions.length > 0 || failed"
    class="space-y-2"
    aria-labelledby="document-file-versions"
  >
    <p v-if="failed" class="text-muted text-sm" role="status">
      {{ t("document.file.versions.loadError") }}
    </p>
    <UCollapsible v-else v-model:open="expanded">
      <UButton
        id="document-file-versions"
        color="neutral"
        variant="link"
        size="sm"
        :icon="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :label="
          t(
            'document.file.versions.title',
            { count: versions.length },
            versions.length,
          )
        "
        class="px-0"
      />
      <template #content>
        <div class="mt-2 space-y-2">
          <p class="text-muted text-sm">
            {{ t("document.file.versions.description") }}
          </p>
          <ul class="divide-default border-default divide-y rounded-md border">
            <li
              v-for="version in versions"
              :key="version.id"
              class="flex flex-wrap items-center gap-3 p-3"
            >
              <UIcon
                name="i-lucide-file-clock"
                class="text-muted size-6 shrink-0"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted text-sm font-medium break-words">
                  {{ version.fileName }}
                </p>
                <p class="text-muted text-xs">{{ uploaded(version) }}</p>
                <p class="text-muted text-xs">{{ replaced(version) }}</p>
              </div>
              <UButton
                :to="version.url"
                target="_blank"
                rel="noopener"
                external
                icon="i-lucide-external-link"
                color="neutral"
                variant="outline"
                size="sm"
                :label="t('document.file.view')"
                :aria-label="`${t('document.file.view')} ${version.fileName} ${t('document.file.opensNewTab')}`"
              />
            </li>
          </ul>
        </div>
      </template>
    </UCollapsible>
  </section>
</template>
