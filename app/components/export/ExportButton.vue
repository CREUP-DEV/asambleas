<script setup lang="ts">
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "~~/shared/constants/security";

const { t, locale } = useI18n();
const toast = useToast();

const props = defineProps<{
  exportUrl: string;
  label?: string;
}>();

type ExportState = "idle" | "starting" | "polling" | "done" | "failed";

const state = ref<ExportState>("idle");
const jobId = ref<string | null>(null);
let pollInterval: ReturnType<typeof setInterval> | null = null;

const isLoading = computed(
  () => state.value === "starting" || state.value === "polling",
);

const buttonLabel = computed(() => {
  switch (state.value) {
    case "starting":
      return t("export.starting");
    case "polling":
      return t("export.generating");
    case "done":
      return t("export.download");
    default:
      return props.label ?? t("export.exportPdf");
  }
});

const buttonIcon = computed(() => {
  switch (state.value) {
    case "done":
      return "i-tabler-download";
    case "failed":
      return "i-tabler-alert-triangle";
    default:
      return "i-tabler-file-type-pdf";
  }
});

async function startExport() {
  if (state.value === "done" && jobId.value) {
    downloadPdf();
    return;
  }

  state.value = "starting";

  try {
    const csrfToken = useCookie(CSRF_COOKIE_NAME).value;
    const result = await $fetch<{ jobId: string }>(props.exportUrl, {
      method: "POST",
      body: { locale: locale.value },
      headers: csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : undefined,
    });

    jobId.value = result.jobId;
    state.value = "polling";
    startPolling();
  } catch {
    state.value = "failed";
    toast.add({ title: t("export.failed"), color: "error" });
  }
}

function startPolling() {
  pollInterval = setInterval(async () => {
    if (!jobId.value) return;

    try {
      const result = await $fetch<{ status: string }>(
        `/api/exports/${jobId.value}/status`,
      );

      if (result.status === "done") {
        state.value = "done";
        stopPolling();
        toast.add({ title: t("export.ready"), color: "success" });
      } else if (result.status === "failed") {
        state.value = "failed";
        stopPolling();
        toast.add({ title: t("export.failed"), color: "error" });
      }
    } catch {
      state.value = "failed";
      stopPolling();
    }
  }, 2000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function downloadPdf() {
  if (!jobId.value) return;
  window.open(`/api/exports/${jobId.value}/download`, "_blank");
  // Reset after download
  setTimeout(() => {
    state.value = "idle";
    jobId.value = null;
  }, 1000);
}

onUnmounted(() => {
  stopPolling();
});
</script>

<template>
  <UButton
    :icon="buttonIcon"
    :label="buttonLabel"
    :loading="isLoading"
    :color="
      state === 'failed' ? 'error' : state === 'done' ? 'success' : 'neutral'
    "
    variant="soft"
    size="sm"
    @click="startExport"
  />
</template>
