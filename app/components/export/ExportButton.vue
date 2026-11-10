<script setup lang="ts">
import type { ExportVariant } from "~~/shared/utils/schemas/export";

/**
 * Asks the server for a PDF export, polls the job and offers the file.
 *
 * - With `document`: POST /api/assemblies/{assembly}/documents/{document}/export
 *   with `{ variant, locale }` (clean or annotated text).
 * - Without it: POST /api/assemblies/{assembly}/export with `{ locale }`.
 * - `exportUrl` overrides both.
 *
 * Status comes from GET /api/exports/{jobId}/status (pending, processing,
 * done, failed). The result is a plain download link: opening a window
 * after the polling would be blocked as a popup.
 */
const props = withDefaults(
  defineProps<{
    /** Assembly slug or id. */
    assembly?: string;
    /** Document slug or id; omit to export the whole assembly. */
    document?: string;
    variant?: ExportVariant;
    /** Explicit export endpoint (takes precedence). */
    exportUrl?: string;
    label?: string;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    color?: "primary" | "secondary" | "neutral";
    buttonVariant?: "solid" | "outline" | "soft" | "subtle" | "ghost" | "link";
    /**
     * Started from elsewhere (a menu item calling `start`): nothing shows
     * until the export is asked for.
     */
    hideIdle?: boolean;
  }>(),
  {
    assembly: undefined,
    document: undefined,
    variant: undefined,
    exportUrl: undefined,
    label: undefined,
    size: "sm",
    color: "neutral",
    buttonVariant: "soft",
    hideIdle: false,
  },
);

type ExportState = "idle" | "starting" | "polling" | "done" | "failed";
type JobStatus = "pending" | "processing" | "done" | "failed";

const POLL_FIRST_MS = 1_000;
const POLL_MAX_MS = 5_000;
/** Give up after this long without a result. */
const POLL_TIMEOUT_MS = 3 * 60_000;

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();

const state = ref<ExportState>("idle");
const jobStatus = ref<JobStatus | null>(null);
const jobId = ref<string | null>(null);
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let startedAt = 0;
let generation = 0;

const endpoint = computed(() => {
  if (props.exportUrl) return props.exportUrl;
  if (!props.assembly) return null;
  const assembly = `/api/assemblies/${encodeURIComponent(props.assembly)}`;
  return props.document
    ? `${assembly}/documents/${encodeURIComponent(props.document)}/export`
    : `${assembly}/export`;
});

const downloadUrl = computed(() =>
  jobId.value
    ? `/api/exports/${encodeURIComponent(jobId.value)}/download`
    : null,
);

const idleLabel = computed(() => {
  if (props.label) return props.label;
  if (props.variant === "annotated") return t("workspace.export.annotated");
  if (props.variant === "clean") return t("workspace.export.clean");
  return t("export.exportPdf");
});

const busyLabel = computed(() =>
  state.value === "starting" ? t("export.starting") : t("export.generating"),
);

/** Announced to screen readers as the job moves on. */
const announcement = computed(() => {
  switch (state.value) {
    case "starting":
    case "polling":
      return busyLabel.value;
    case "done":
      return t("export.ready");
    case "failed":
      return t("export.failed");
    default:
      return "";
  }
});

function stopPolling(): void {
  clearTimeout(pollTimer);
  pollTimer = undefined;
}

function fail(message?: string): void {
  stopPolling();
  state.value = "failed";
  toast.add({
    title: t("export.failed"),
    description: message,
    color: "error",
    icon: "i-lucide-circle-alert",
  });
}

function schedulePoll(delay: number, gen: number): void {
  pollTimer = setTimeout(() => void poll(delay, gen), delay);
}

async function poll(delay: number, gen: number): Promise<void> {
  if (gen !== generation || !jobId.value) return;
  try {
    const result = await api.get<{ status: JobStatus }>(
      `/api/exports/${encodeURIComponent(jobId.value)}/status`,
    );
    if (gen !== generation) return;
    jobStatus.value = result.status;
    if (result.status === "done") {
      stopPolling();
      state.value = "done";
      toast.add({
        title: t("export.ready"),
        color: "success",
        icon: "i-lucide-file-check",
      });
      return;
    }
    if (result.status === "failed") {
      fail();
      return;
    }
  } catch (error) {
    if (gen !== generation) return;
    // Network hiccups are retried; a real refusal ends the job.
    const status = api.errorStatus(error);
    if (status !== null && status < 500) {
      api.notifyError(error, "export.failed");
      stopPolling();
      state.value = "failed";
      return;
    }
  }
  if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
    fail(t("workspace.export.timeout"));
    return;
  }
  schedulePoll(Math.min(Math.round(delay * 1.5), POLL_MAX_MS), gen);
}

async function start(): Promise<void> {
  if (
    !endpoint.value ||
    state.value === "starting" ||
    state.value === "polling"
  ) {
    return;
  }
  stopPolling();
  generation += 1;
  const gen = generation;
  state.value = "starting";
  jobStatus.value = null;
  jobId.value = null;
  try {
    const body: Record<string, string> = {
      locale: locale.value === "en" ? "en" : "es",
    };
    if (props.document && props.variant) body.variant = props.variant;
    const result = await api.send<{ jobId: string }>(endpoint.value, { body });
    if (gen !== generation) return;
    jobId.value = result.jobId;
    state.value = "polling";
    startedAt = Date.now();
    schedulePoll(POLL_FIRST_MS, gen);
  } catch (error) {
    if (gen !== generation) return;
    state.value = "failed";
    api.notifyError(error, "export.failed");
  }
}

function reset(): void {
  stopPolling();
  generation += 1;
  state.value = "idle";
  jobId.value = null;
  jobStatus.value = null;
}

watch(endpoint, reset);
watch(() => props.variant, reset);
onBeforeUnmount(() => {
  generation += 1;
  stopPolling();
});

defineExpose({ start });
</script>

<template>
  <span class="inline-flex items-center gap-1">
    <UButton
      v-if="state === 'done' && downloadUrl"
      :to="downloadUrl"
      external
      download
      icon="i-lucide-download"
      color="success"
      :variant="buttonVariant"
      :size="size"
      :label="t('export.download')"
    />
    <UButton
      v-else-if="!hideIdle || state !== 'idle'"
      :icon="state === 'failed' ? 'i-lucide-rotate-ccw' : 'i-lucide-file-text'"
      :color="state === 'failed' ? 'error' : color"
      :variant="buttonVariant"
      :size="size"
      :loading="state === 'starting' || state === 'polling'"
      :disabled="!endpoint"
      :label="
        state === 'starting' || state === 'polling'
          ? busyLabel
          : state === 'failed'
            ? t('workspace.export.retry')
            : idleLabel
      "
      @click="start"
    />
    <!-- Started from a menu, the menu asks for it again. -->
    <UButton
      v-if="state === 'done' && !hideIdle"
      icon="i-lucide-refresh-cw"
      color="neutral"
      variant="ghost"
      :size="size"
      :aria-label="t('workspace.export.again')"
      @click="
        reset();
        start();
      "
    />
    <span class="sr-only" role="status" aria-live="polite">
      {{ announcement }}
    </span>
  </span>
</template>
