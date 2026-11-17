<script setup lang="ts">
import { formatMoment } from "~/utils/format";
import {
  packageDownloadUrl,
  usePackageDownload,
  type PackageJob,
  type PackageTarget,
} from "~/composables/export/usePackageDownload";

/**
 * "Descargar documentación": the assembly's documentation package, a ZIP
 * with the convocatoria, the agenda and a folder per item with its
 * published documents and their amendments. The same for everyone (only
 * what is public), built once per state of the assembly on the server.
 *
 * Opening it asks for the package (POST .../package): it answers at once
 * when it is ready, otherwise the server builds it. The build is followed
 * by usePackageDownload, not here: the dialog may be closed and the user
 * goes on browsing, and a toast offers the download once it is ready.
 * While it builds, an earlier ZIP whose content is all still public can be
 * downloaded. "Incluir versión editable" asks for the variant with the
 * Word version of every text.
 */
const props = defineProps<{
  /** The assembly's API base, "/api/assemblies/80-ago". */
  apiBase: string;
}>();
const open = defineModel<boolean>("open", { default: false });

const { t, locale } = useI18n();
const packages = usePackageDownload();

const editable = ref(false);
const target = computed<PackageTarget>(() => ({
  apiBase: props.apiBase,
  locale: locale.value === "en" ? "en" : "es",
  editable: editable.value,
}));
const entry = computed(() => packages.job(target.value));
const status = computed(() => entry.value.status);
const asking = computed(() => entry.value.asking);
const downloadUrl = computed(() => packageDownloadUrl(target.value));

function request(): void {
  void packages.request(target.value);
}

// While open, the dialog shows the package itself: no toast for it.
let watched: PackageJob | null = null;
function follow(next: PackageJob | null): void {
  if (watched === next) return;
  if (watched) watched.watchers -= 1;
  if (next) next.watchers += 1;
  watched = next;
}
watch(
  [open, entry],
  ([isOpen, current]) => {
    follow(isOpen ? current : null);
    if (isOpen) request();
  },
  { immediate: true },
);
onBeforeUnmount(() => follow(null));

const building = computed(
  () => asking.value || status.value?.status === "building",
);
const ready = computed(() => status.value?.status === "ready");
const failed = computed(
  () => entry.value.failed || status.value?.status === "failed",
);
const file = computed(() => status.value?.file ?? null);

const progressValue = computed(() => {
  const progress = status.value?.progress;
  return progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : null;
});

function size(bytes: number): string {
  return new Intl.NumberFormat(locale.value, {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 1,
  }).format(Math.max(bytes / 1_000_000, 0.1));
}

function preparedAt(value: string): string {
  return formatMoment(value, { locale: locale.value }).text;
}

/** Said to screen readers as the package moves on. */
const announcement = computed(() => {
  if (failed.value) return t("assembly.package.failed");
  if (ready.value) return t("assembly.package.ready");
  if (building.value) return t("assembly.package.preparing");
  return "";
});
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('assembly.package.title')"
    :description="t('assembly.package.description')"
  >
    <template #body>
      <div class="space-y-5">
        <UCheckbox
          v-model="editable"
          :label="t('assembly.package.editable')"
          :description="t('assembly.package.editableHelp')"
          :disabled="asking"
        />

        <div v-if="building" class="space-y-2" data-testid="package-building">
          <p class="text-default flex items-center gap-2 text-sm">
            <UIcon
              name="i-lucide-loader-circle"
              class="text-primary size-4 shrink-0 animate-spin"
              aria-hidden="true"
            />
            {{ t("assembly.package.preparing") }}
          </p>
          <UProgress
            :model-value="progressValue"
            size="sm"
            :aria-label="t('assembly.package.preparing')"
          />
          <p v-if="status?.progress" class="text-muted text-xs tabular-nums">
            {{
              t("assembly.package.progress", {
                done: status.progress.done,
                total: status.progress.total,
              })
            }}
          </p>
          <p v-else-if="!asking" class="text-muted text-xs">
            {{ t("assembly.package.queued") }}
          </p>
          <p class="text-muted text-xs">
            {{ t("assembly.package.background") }}
          </p>
          <div
            v-if="file && !file.current"
            class="border-default space-y-2 border-t pt-3"
          >
            <p class="text-muted text-sm">
              {{
                t("assembly.package.olderAvailable", {
                  date: preparedAt(file.builtAt),
                })
              }}
            </p>
            <UButton
              :to="downloadUrl"
              external
              download
              color="neutral"
              variant="outline"
              icon="i-lucide-download"
              :label="
                t('assembly.package.downloadOlder', { size: size(file.bytes) })
              "
            />
          </div>
        </div>

        <div
          v-else-if="ready && file"
          class="space-y-3"
          data-testid="package-ready"
        >
          <p class="text-default flex items-center gap-2 text-sm">
            <UIcon
              name="i-lucide-circle-check"
              class="text-success size-4 shrink-0"
              aria-hidden="true"
            />
            {{ t("assembly.package.ready") }}
            <span class="text-muted">
              {{
                t("assembly.package.builtAt", {
                  date: preparedAt(file.builtAt),
                })
              }}
            </span>
          </p>
          <UButton
            :to="downloadUrl"
            external
            download
            icon="i-lucide-download"
            :label="t('assembly.package.download', { size: size(file.bytes) })"
          />
        </div>

        <div v-else-if="failed" class="space-y-3">
          <p class="text-default flex items-center gap-2 text-sm">
            <UIcon
              name="i-lucide-circle-alert"
              class="text-error size-4 shrink-0"
              aria-hidden="true"
            />
            {{ t("assembly.package.failed") }}
          </p>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-rotate-ccw"
            :label="t('assembly.package.retry')"
            @click="request"
          />
        </div>

        <span class="sr-only" role="status" aria-live="polite">
          {{ announcement }}
        </span>
      </div>
    </template>
  </UModal>
</template>
