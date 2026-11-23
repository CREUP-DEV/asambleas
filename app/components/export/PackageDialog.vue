<script setup lang="ts">
import type { PackageOptionsDto } from "~~/shared/types/api";
import { formatMoment } from "~/utils/format";
import { selectMenuLabel } from "~/utils/selectMenu";
import {
  packageDownloadUrl,
  usePackageDownload,
  type PackageJob,
  type PackageTarget,
} from "~/composables/export/usePackageDownload";
import {
  authorChoices,
  documentMenuValues,
  documentsAfterMenu,
  groupValue,
  packageSelectionOf,
  packageSummary,
  presetState,
  type AmendmentMode,
  type PackageFilterState,
  type PackagePreset,
} from "./-packageFilters";

/**
 * "Descargar documentación": the assembly's documentation package, a ZIP
 * with the convocatoria, the agenda and a folder per item with its
 * published documents and their amendments. The same for everyone (only
 * what is public), built once per state of the assembly on the server.
 *
 * Filters take a part of it (user's decision of 2026-11-20): some documents
 * (by agenda item or one by one; all by default), with or without their
 * texts, and all, none or some of their amendments (those some members
 * sign, or the ones the control sheet showed: `preset.amendmentIds`). A part
 * holds no convocatoria nor agenda, and keeps the whole package's folders.
 * Both menus are searched by typing; the members' menu puts a council's
 * university first (user's decision of 2026-11-20). What the menus offer
 * comes from GET .../package/options, as the public reads it, so an office
 * is the generic "CEA" whoever asks.
 *
 * Opening it asks for the package (POST .../package): it answers at once
 * when it is ready, otherwise the server builds it. A part is asked for
 * once its filters stay still for a moment. The build is followed by
 * usePackageDownload, not here: the dialog may be closed and the user goes
 * on browsing, and a toast offers the download once it is ready. While the
 * whole package builds, an earlier ZIP whose content is all still public
 * can be downloaded. "Incluir versión editable" asks for the variant with
 * the Word version of every text.
 */
const props = withDefaults(
  defineProps<{
    /** The assembly's API base, "/api/assemblies/80-ago". */
    apiBase: string;
    /** What the filters start from each time the dialog opens. */
    preset?: PackagePreset | null;
  }>(),
  { preset: null },
);
const open = defineModel<boolean>("open", { default: false });

const { t, locale } = useI18n();
const { justifiedText } = useAccessibilityPreferences();
const api = useApi();
const packages = usePackageDownload();

const editable = ref(false);
const state = reactive<PackageFilterState>(presetState(null));

// What the filters offer ------------------------------------------------------------

const options = ref<PackageOptionsDto | null>(null);
const optionsFailed = ref(false);
const optionsLoading = ref(false);

async function loadOptions(): Promise<void> {
  optionsLoading.value = true;
  optionsFailed.value = false;
  try {
    options.value = await api.get<PackageOptionsDto>(
      `${props.apiBase}/package/options`,
    );
  } catch {
    optionsFailed.value = true;
  } finally {
    optionsLoading.value = false;
  }
}

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    Object.assign(state, presetState(props.preset));
    void loadOptions();
  },
  { immediate: true },
);

const groups = computed(() => options.value?.groups ?? []);
const documentById = computed(
  () =>
    new Map(
      (options.value?.documents ?? []).map((document) => [
        document.id,
        document,
      ]),
    ),
);

/**
 * A document by its sub-item's number and title ("17.1. Resolución…"), as
 * the agenda names it, without its reference (user's decision of
 * 2026-11-20).
 */
function documentLabel(id: string): string {
  const document = documentById.value.get(id);
  if (!document) return "";
  return document.numbering
    ? `${document.numbering}. ${document.title}`
    : document.title;
}

function itemLabel(group: PackageOptionsDto["groups"][number]): string {
  return `${group.numbering}. ${group.title ?? t("assembly.package.itemHidden")}`;
}

/**
 * One block per agenda item: the item itself (all its documents), then
 * each document by its sub-item's number and title.
 */
const documentItems = computed(() =>
  groups.value.map((group) => {
    return [
      {
        value: groupValue(group.id),
        label: itemLabel(group),
        description: t(
          "assembly.package.wholeItem",
          { count: group.documentIds.length },
          group.documentIds.length,
        ),
        ui: { itemLabel: "font-semibold whitespace-normal" },
      },
      ...group.documentIds.map((id) => ({
        value: id,
        label: documentLabel(id),
        ui: { item: "ps-5", itemLabel: "whitespace-normal" },
      })),
    ];
  }),
);

const documentValues = computed<string[]>({
  get: () => documentMenuValues(state.documentIds, groups.value),
  set: (next) => {
    state.documentIds = documentsAfterMenu(
      documentValues.value,
      next,
      groups.value,
    );
  },
});

const documentsShown = computed(() => {
  const count = state.documentIds.length;
  if (count === 0) return t("assembly.package.documentsAll");
  const whole = groups.value.find(
    (group) =>
      group.documentIds.length === count &&
      group.documentIds.every((id) => state.documentIds.includes(id)),
  );
  if (whole && count > 1) return itemLabel(whole);
  if (count === 1) return documentLabel(state.documentIds[0]!);
  return t("assembly.package.documentsChosen", { count }, count);
});

// Amendments ------------------------------------------------------------------------

const modeItems = computed(() => [
  ...(props.preset?.amendmentIds
    ? [
        {
          value: "selected" as const,
          label: t(
            "assembly.package.amendmentsSelected",
            { count: props.preset.amendmentIds.length },
            props.preset.amendmentIds.length,
          ),
        },
      ]
    : []),
  { value: "all" as const, label: t("assembly.package.amendmentsAll") },
  { value: "authors" as const, label: t("assembly.package.amendmentsAuthors") },
  { value: "none" as const, label: t("assembly.package.amendmentsNone") },
]);

const authors = computed(() =>
  options.value ? authorChoices(options.value, state.documentIds) : [],
);

/**
 * A member as the menu shows it: a council by its university first, then
 * its acronym and denomination; any other member by its denomination.
 */
const authorItems = computed(() =>
  authors.value.map((author) => ({
    value: author.id,
    label: author.university ?? author.name,
    acronym: author.acronym,
    description: [
      author.acronym,
      author.university ? author.name : null,
      t(
        "assembly.package.amendmentCount",
        { count: author.count },
        author.count,
      ),
    ]
      .filter(Boolean)
      .join(" · "),
  })),
);

// A member no longer in the documents chosen is no longer chosen.
watch(authors, (list) => {
  const offered = new Set(list.map((author) => author.id));
  const kept = state.memberIds.filter((id) => offered.has(id));
  if (kept.length !== state.memberIds.length) state.memberIds = kept;
});

const authorsShown = computed(() => {
  const acronyms = new Map(authors.value.map((a) => [a.id, a.acronym]));
  return state.memberIds
    .map((id) => acronyms.get(id))
    .filter(Boolean)
    .join(", ");
});

// The package asked for -------------------------------------------------------------

const summary = computed(() =>
  options.value ? packageSummary(options.value, state) : null,
);
const selection = computed(() =>
  packageSelectionOf(
    state,
    (options.value?.documents ?? []).map((document) => document.id),
  ),
);
/** «De ciertos enmendantes» with nobody chosen yet: nothing is asked for. */
const incomplete = computed(
  () => state.amendments === "authors" && state.memberIds.length === 0,
);
/** The filters take nothing (known once the options are in). */
const nothingChosen = computed(
  () =>
    summary.value !== null &&
    summary.value.documents === 0 &&
    summary.value.amendments === 0,
);

/** A menu is open: the choice is still being made. */
const documentsMenuOpen = ref(false);
const authorsMenuOpen = ref(false);
const choosing = computed(
  () => documentsMenuOpen.value || authorsMenuOpen.value,
);

/**
 * The part asked for: its filters once the menus are closed and nothing
 * moved for a moment, and once the options are in (choosing every document
 * is the whole package). Each request spends the export bucket the room
 * shares (EXPORT_RATE_LIMIT), so it goes once per choice, not per tick.
 */
const asked = ref<PackageTarget["selection"]>(null);
let settle: ReturnType<typeof setTimeout> | undefined;
watch(
  [selection, choosing, () => options.value !== null],
  ([next, busy, known]) => {
    clearTimeout(settle);
    if (!next) {
      asked.value = null;
      return;
    }
    if (busy || !known) return;
    settle = setTimeout(() => {
      asked.value = next;
    }, 800);
  },
  { immediate: true, deep: true },
);
onBeforeUnmount(() => clearTimeout(settle));

const target = computed<PackageTarget>(() => ({
  apiBase: props.apiBase,
  locale: locale.value === "en" ? "en" : "es",
  editable: editable.value,
  justified: justifiedText.value,
  selection: asked.value,
}));
/** The filters on screen are not the ones asked for yet. */
const settling = computed(
  () => JSON.stringify(selection.value) !== JSON.stringify(asked.value),
);
const entry = computed(() => packages.job(target.value));
const status = computed(() => entry.value.status);
const asking = computed(() => entry.value.asking);
const downloadUrl = computed(() =>
  packageDownloadUrl(target.value, status.value?.part?.key ?? null),
);

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
  [open, entry, nothingChosen, incomplete, settling],
  ([isOpen, current, nothing, unfinished, moving]) => {
    follow(isOpen ? current : null);
    if (isOpen && !nothing && !unfinished && !moving) request();
  },
  { immediate: true },
);
onBeforeUnmount(() => follow(null));

const building = computed(
  () =>
    !nothingChosen.value &&
    !incomplete.value &&
    (settling.value || asking.value || status.value?.status === "building"),
);
const ready = computed(
  () => !settling.value && status.value?.status === "ready",
);
const empty = computed(
  () =>
    !incomplete.value &&
    (nothingChosen.value ||
      (!settling.value && status.value?.status === "empty")),
);
const failed = computed(
  () =>
    !settling.value &&
    (entry.value.failed || status.value?.status === "failed"),
);
const file = computed(() => status.value?.file ?? null);
const isPart = computed(() => asked.value !== null);

const progressValue = computed(() => {
  const progress = status.value?.progress;
  return progress && progress.total > 0
    ? Math.round((progress.done / progress.total) * 100)
    : null;
});

const summaryText = computed(() => {
  const counts = summary.value;
  if (!counts) return "";
  const documents = t(
    "assembly.package.summaryDocuments",
    { count: counts.documents },
    counts.documents,
  );
  const amendments = t(
    "assembly.package.summaryAmendments",
    { count: counts.amendments },
    counts.amendments,
  );
  return t(
    selection.value
      ? "assembly.package.summary"
      : "assembly.package.summaryAll",
    { documents, amendments },
  );
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
  if (empty.value) return t("assembly.package.empty");
  if (failed.value) return t("assembly.package.failed");
  if (ready.value) return t("assembly.package.ready");
  if (building.value) return t("assembly.package.preparing");
  return "";
});

function setMode(value: AmendmentMode): void {
  state.amendments = value;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('assembly.package.title')"
    :description="t('assembly.package.description')"
  >
    <template #body>
      <div class="space-y-5">
        <UAlert
          v-if="optionsFailed"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="t('assembly.package.optionsError')"
          :actions="[
            {
              label: t('assembly.package.retry'),
              color: 'neutral',
              variant: 'outline',
              onClick: () => void loadOptions(),
            },
          ]"
        />

        <UFormField :label="t('assembly.package.documents')">
          <USelectMenu
            v-model="documentValues"
            v-model:open="documentsMenuOpen"
            :items="documentItems"
            value-key="value"
            multiple
            :loading="optionsLoading"
            :disabled="!options"
            :search-input="{
              placeholder: t('assembly.package.documentsSearch'),
            }"
            :filter-fields="['label', 'description']"
            :ui="{ content: 'min-w-80', value: 'whitespace-normal text-start' }"
            class="w-full"
            :aria-label="
              selectMenuLabel(
                t('assembly.package.documents'),
                [],
                [],
                documentsShown,
              )
            "
            data-testid="package-documents"
          >
            <span class="truncate">{{ documentsShown }}</span>
          </USelectMenu>
        </UFormField>

        <UCheckbox
          v-model="state.texts"
          :label="t('assembly.package.texts')"
          :description="t('assembly.package.textsHelp')"
          data-testid="package-texts"
        />

        <UFormField :label="t('assembly.package.amendments')">
          <URadioGroup
            :model-value="state.amendments"
            :items="modeItems"
            value-key="value"
            orientation="horizontal"
            :ui="{ fieldset: 'flex-wrap gap-x-4 gap-y-2' }"
            data-testid="package-amendments"
            @update:model-value="setMode($event as AmendmentMode)"
          />
        </UFormField>

        <UFormField
          v-if="state.amendments === 'authors'"
          :label="t('assembly.package.authors')"
        >
          <USelectMenu
            v-model="state.memberIds"
            v-model:open="authorsMenuOpen"
            :items="authorItems"
            value-key="value"
            multiple
            :disabled="!options"
            :placeholder="t('assembly.package.authorsPlaceholder')"
            :search-input="{ placeholder: t('assembly.package.authorsSearch') }"
            :filter-fields="['label', 'acronym', 'description']"
            :ui="{
              content: 'min-w-80',
              itemLabel: 'whitespace-normal break-words font-medium',
              itemDescription: 'whitespace-normal break-words text-muted',
            }"
            class="w-full"
            :aria-label="
              selectMenuLabel(
                t('assembly.package.authors'),
                authorItems,
                state.memberIds,
                t('assembly.package.authorsPlaceholder'),
              )
            "
            data-testid="package-authors"
          >
            <span v-if="authorsShown" class="truncate">{{ authorsShown }}</span>
            <span v-else class="text-dimmed truncate">{{
              t("assembly.package.authorsPlaceholder")
            }}</span>
          </USelectMenu>
        </UFormField>

        <UCheckbox
          v-model="editable"
          :label="t('assembly.package.editable')"
          :description="t('assembly.package.editableHelp')"
          :disabled="asking"
        />

        <div v-if="summary && !incomplete" class="text-muted space-y-1 text-sm">
          <p data-testid="package-summary">{{ summaryText }}</p>
          <p v-if="summary.dropped > 0">
            {{
              t(
                "assembly.package.dropped",
                { count: summary.dropped },
                summary.dropped,
              )
            }}
          </p>
        </div>

        <p
          v-if="incomplete"
          class="text-muted text-sm"
          data-testid="package-authors-needed"
        >
          {{ t("assembly.package.authorsNeeded") }}
        </p>

        <p
          v-else-if="empty"
          class="text-default flex items-center gap-2 text-sm"
          data-testid="package-empty"
        >
          <UIcon
            name="i-lucide-circle-slash"
            class="text-muted size-4 shrink-0"
            aria-hidden="true"
          />
          {{ t("assembly.package.empty") }}
        </p>

        <div
          v-else-if="building"
          class="space-y-2"
          data-testid="package-building"
        >
          <p class="text-default flex items-center gap-2 text-sm">
            <UIcon
              name="i-lucide-loader-circle"
              class="text-primary size-4 shrink-0 animate-spin"
              aria-hidden="true"
            />
            {{ t("assembly.package.preparing") }}
          </p>
          <template v-if="!settling">
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
          </template>
          <div
            v-if="file && !file.current && !isPart"
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
            <span v-if="!isPart" class="text-muted">
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
            :label="
              t(
                isPart
                  ? 'assembly.package.downloadAbout'
                  : 'assembly.package.download',
                { size: size(file.bytes) },
              )
            "
            data-testid="package-download"
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
