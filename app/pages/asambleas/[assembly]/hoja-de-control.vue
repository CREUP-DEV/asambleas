<script setup lang="ts">
import type { TabsItem } from "@nuxt/ui";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AmendmentDto,
  ControlSheetAmendmentRowDto,
  ControlSheetDto,
  ControlSheetItemRowDto,
  DocumentAmendmentsDto,
  LiveStateDto,
} from "~~/shared/types/api";
import {
  affectsControlSheet,
  affectsLiveDebate,
  amendedDocuments,
  buildAmendmentRows,
  buildGeneralRows,
  type AmendmentSheetRow,
  type GeneralSheetRow,
  type SheetRowDocument,
} from "~/components/control-sheet/-model";
import type { RowPanelTarget } from "~/components/control-sheet/RowPanel.vue";
import {
  buildAgendaTree,
  flattenAgendaTree,
  numberedAgendaTitle,
} from "~/utils/agendaTree";

/**
 * The control sheet of the assembly (hoja de control), for the Mesa, the
 * CEA, the Secretaría and the Presidencia (control_sheet:view or :edit):
 * «General», one row per agenda item with documents, and «Enmiendas», the
 * amendments of one document. It replaces the spreadsheet they kept during
 * the session and feeds the minutes (docs/control-sheet-plan.md).
 *
 * The agenda comes from the hub (useAssemblyAgenda); the sheet's own answer
 * adds the final votes, the amendment counts and who spoke. «Seguir el
 * debate» opens what the Mesa has on screen and marks its row.
 */

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const route = useRoute();
const router = useRouter();
const { can } = useMe();
const { assembly, apiBase, sectionPath, onLive } = useCurrentAssembly();

useHead({
  title: () =>
    [t("controlSheet.title"), assembly.value?.label]
      .filter(Boolean)
      .join(" · "),
});

const allowed = computed(
  () =>
    can(PERMISSION_KEYS.CONTROL_SHEET_VIEW) ||
    can(PERMISSION_KEYS.CONTROL_SHEET_EDIT),
);

const sheetFetch = useFetch<ControlSheetDto>(
  () => `${apiBase.value}/control-sheet`,
  {
    key: computed(() => `control-sheet-${assembly.value?.id ?? "none"}`),
    immediate: allowed.value,
    dedupe: "defer",
  },
);
const { data: sheet, stale } = keepLastGoodData(sheetFetch, {
  resetOn: () => assembly.value?.id,
});
useStaleDataNotice(stale);

const liveFetch = useFetch<LiveStateDto>(() => `${apiBase.value}/live-state`, {
  key: computed(() => `control-sheet-live-${assembly.value?.id ?? "none"}`),
  immediate: allowed.value,
  dedupe: "defer",
});

const agenda = useAssemblyAgenda();
await Promise.all([sheetFetch, liveFetch, agenda]);

const live = computed(() => liveFetch.data.value ?? null);
const items = computed(() => agenda.data.value?.items ?? []);
const agendaDocuments = computed(() => agenda.data.value?.documents ?? []);

// Tabs and the document of «Enmiendas» live in the query ----------------------

type SheetTab = "general" | "amendments";
const TAB_QUERY = "vista";
const DOCUMENT_QUERY = "documento";

const tab = computed<SheetTab>({
  get: () =>
    route.query[TAB_QUERY] === "enmiendas" ? "amendments" : "general",
  set: (value) => {
    void router.replace({
      query: {
        ...route.query,
        [TAB_QUERY]: value === "amendments" ? "enmiendas" : undefined,
      },
    });
  },
});
const tabItems = computed<TabsItem[]>(() => [
  { value: "general", label: t("controlSheet.tabs.general") },
  { value: "amendments", label: t("controlSheet.tabs.amendments") },
]);

const documentOptions = computed(() =>
  amendedDocuments(agendaDocuments.value, sheet.value ?? null, items.value),
);
const selectedDocument = computed(() => {
  const wanted = route.query[DOCUMENT_QUERY];
  return (
    documentOptions.value.find(
      (document) => document.slug === wanted || document.id === wanted,
    ) ??
    documentOptions.value[0] ??
    null
  );
});
const selectItems = computed(() =>
  documentOptions.value.map((document) => ({
    value: document.id,
    label: document.reference ?? document.title,
    description:
      document.undecided > 0
        ? t(
            "controlSheet.document.undecided",
            { count: document.undecided },
            document.undecided,
          )
        : t(
            "controlSheet.document.total",
            { count: document.amendments },
            document.amendments,
          ),
  })),
);
const selectedDocumentId = computed<string | undefined>({
  get: () => selectedDocument.value?.id,
  set: (id) => {
    const document = documentOptions.value.find((entry) => entry.id === id);
    if (!document) return;
    void router.replace({
      query: { ...route.query, [DOCUMENT_QUERY]: document.slug },
    });
  },
});

// Amendments of the chosen document ---------------------------------------------

const amendmentsUrl = computed(() =>
  selectedDocument.value
    ? `${apiBase.value}/documents/${encodeURIComponent(selectedDocument.value.id)}/amendments`
    : null,
);
type SheetAmendments = DocumentAmendmentsDto & { documentId: string };
const amendmentsFetch = useAsyncData<SheetAmendments | null>(
  computed(() => `control-sheet-amendments:${amendmentsUrl.value ?? "none"}`),
  async () => {
    const documentId = selectedDocument.value?.id;
    if (!amendmentsUrl.value || !allowed.value || !documentId) return null;
    const dto = await api.get<DocumentAmendmentsDto>(amendmentsUrl.value);
    return { ...dto, documentId };
  },
  { default: () => null, lazy: true },
);
const { data: keptAmendments } = keepLastGoodData(amendmentsFetch, {
  resetOn: amendmentsUrl,
});
// Nuxt seeds a new key with the previous key's data until it lands: only
// the chosen document's amendments are ever shown under it.
const amendmentsData = onlyForKey(
  keptAmendments,
  () => selectedDocument.value?.id,
  (value) => value.documentId,
);

const generalRows = computed(() =>
  buildGeneralRows(
    items.value,
    agendaDocuments.value,
    sheet.value ?? null,
    live.value?.agendaItemId ?? null,
  ),
);
const amendmentRows = computed(() =>
  buildAmendmentRows(
    amendmentsData.value?.amendments ?? [],
    sheet.value?.sessionStartedAt ?? null,
    live.value?.amendmentId ?? null,
    sheet.value?.amendmentRows ?? [],
  ),
);

// The row panel ------------------------------------------------------------------

const canEdit = computed(() => sheet.value?.can.edit ?? false);
const canModerate = computed(() => sheet.value?.can.moderate ?? false);
const panelOpen = ref(false);
/** What the panel shows, by id, so a refetch brings its row up to date. */
const panelSubject = ref<
  { kind: "item"; id: string } | { kind: "amendment"; id: string } | null
>(null);
const freshPanelTarget = computed<RowPanelTarget | null>(() => {
  const subject = panelSubject.value;
  if (!subject) return null;
  if (subject.kind === "item") {
    const row = generalRows.value.find((entry) => entry.id === subject.id);
    return row ? { kind: "item", row } : null;
  }
  const row = amendmentRows.value.find(
    (entry) => entry.amendment.id === subject.id,
  );
  return row
    ? {
        kind: "amendment",
        row,
        code: row.amendment.code ?? t("amendment.unnumberedLabel"),
      }
    : null;
});
/**
 * The panel's row: the fresh one while the lists hold it, the last one seen
 * otherwise (following the debate to another document, a refetch on the
 * way), so the panel and what is being typed in it never vanish.
 */
const lastPanelTarget = shallowRef<RowPanelTarget | null>(null);
watch(freshPanelTarget, (target) => {
  if (target) lastPanelTarget.value = target;
});
const panelTarget = computed<RowPanelTarget | null>(() => {
  const fresh = freshPanelTarget.value;
  if (fresh) return fresh;
  const last = lastPanelTarget.value;
  const subject = panelSubject.value;
  if (!last || !subject) return null;
  const id = last.kind === "item" ? last.row.id : last.row.amendment.id;
  return last.kind === subject.kind && id === subject.id ? last : null;
});

function openItem(row: GeneralSheetRow): void {
  lastPanelTarget.value = { kind: "item", row };
  panelSubject.value = { kind: "item", id: row.id };
  panelOpen.value = true;
}

function openAmendment(row: AmendmentSheetRow): void {
  lastPanelTarget.value = {
    kind: "amendment",
    row,
    code: row.amendment.code ?? t("amendment.unnumberedLabel"),
  };
  panelSubject.value = { kind: "amendment", id: row.amendment.id };
  panelOpen.value = true;
}

/** Puts a saved row in place at once; the live refetch follows. */
function onItemSaved(row: ControlSheetItemRowDto): void {
  const current = sheet.value;
  if (!current) return;
  sheet.value = {
    ...current,
    itemRows: [...current.itemRows.filter((entry) => entry.id !== row.id), row],
  };
}

function onAmendmentSaved(row: ControlSheetAmendmentRowDto): void {
  const current = sheet.value;
  if (!current) return;
  sheet.value = {
    ...current,
    amendmentRows: [
      ...current.amendmentRows.filter((entry) => entry.id !== row.id),
      row,
    ],
  };
}

// Adding an item without documents ------------------------------------------------

const addOpen = ref(false);
const addChoice = ref<string | undefined>(undefined);
const adding = ref(false);
const addItems = computed(() => {
  const withDocuments = new Set(
    agendaDocuments.value
      .filter((document) => document.status !== "draft")
      .map((document) => document.agendaItemId),
  );
  const listed = new Set(
    (sheet.value?.itemRows ?? [])
      .filter((row) => row.listed)
      .map((row) => row.agendaItemId),
  );
  return flattenAgendaTree(buildAgendaTree(items.value))
    .filter(
      (node) => !withDocuments.has(node.item.id) && !listed.has(node.item.id),
    )
    .map((node) => ({
      value: node.item.id,
      label: numberedAgendaTitle(
        node.number,
        node.item.title,
        t("agenda.unlisted.inText"),
      ),
    }));
});

async function addItem(): Promise<void> {
  const id = addChoice.value;
  if (!id || adding.value) return;
  adding.value = true;
  const current = sheet.value?.itemRows.find((row) => row.agendaItemId === id);
  try {
    const row = await api.send<ControlSheetItemRowDto>(
      `${apiBase.value}/control-sheet/items/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: {
          listed: { value: true, updatedAt: current?.listedUpdatedAt ?? null },
        },
      },
    );
    onItemSaved(row);
    addOpen.value = false;
    addChoice.value = undefined;
    toast.add({
      title: t("controlSheet.add.added"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    api.notifyError(error, "controlSheet.add.failed");
    refreshSheet();
  } finally {
    adding.value = false;
  }
}

function documentPath(document: SheetRowDocument): string {
  return sectionPath(`documentos/${encodeURIComponent(document.slug)}`);
}

function amendmentPath(amendment: AmendmentDto): string {
  const document = selectedDocument.value;
  if (!document) return sectionPath("documentos");
  const base = sectionPath(`documentos/${encodeURIComponent(document.slug)}`);
  return `${base}?enmienda=${encodeURIComponent(amendment.id)}`;
}

// Live -----------------------------------------------------------------------

function refreshSheet(): void {
  if (!allowed.value) return;
  void sheetFetch.refresh({ dedupe: "defer" });
  if (amendmentsUrl.value) void amendmentsFetch.refresh();
}

onLive((events) => {
  if (affectsControlSheet(events)) refreshSheet();
  if (affectsLiveDebate(events) && allowed.value) {
    void liveFetch.refresh({ dedupe: "defer" });
  }
});

// Following the debate ----------------------------------------------------------

/** On while the assembly is in session, unless the reader turns it off. */
const follow = ref(assembly.value?.status === "in_session");

function scrollToRow(id: string): void {
  if (!import.meta.client) return;
  void nextTick(() => {
    // The table and the cards are both in the page; one of them shows.
    const row = [
      ...document.querySelectorAll<HTMLElement>(
        `[data-sheet-row="${CSS.escape(id)}"]`,
      ),
    ].find((element) => element.getClientRects().length > 0);
    if (!row) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    row.scrollIntoView({
      block: "center",
      behavior: reduce ? "auto" : "smooth",
    });
  });
}

/** Opens what the Mesa has on screen: its amendment, or its item. */
async function followDebate(): Promise<void> {
  const state = live.value;
  if (!follow.value || !state) return;
  if (state.amendmentId && state.documentId) {
    const document = documentOptions.value.find(
      (entry) => entry.id === state.documentId,
    );
    if (document) {
      await router.replace({
        query: {
          ...route.query,
          [TAB_QUERY]: "enmiendas",
          [DOCUMENT_QUERY]: document.slug,
        },
      });
      scrollToRow(state.amendmentId);
      return;
    }
  }
  if (state.agendaItemId) {
    if (tab.value !== "general") {
      await router.replace({
        query: { ...route.query, [TAB_QUERY]: undefined },
      });
    }
    scrollToRow(state.agendaItemId);
  }
}

// Only when what is on screen moves (or following is turned on), not on
// every refetch of the live state.
watch(
  [
    () => live.value?.agendaItemId,
    () => live.value?.documentId,
    () => live.value?.amendmentId,
    follow,
  ],
  () => void followDebate(),
);
// The session opening while the sheet is open turns following on.
watch(
  () => assembly.value?.status,
  (status, previous) => {
    if (status === "in_session" && previous !== "in_session") {
      follow.value = true;
    }
  },
);
watch(
  () => amendmentRows.value.length,
  () => {
    if (follow.value && live.value?.amendmentId) {
      scrollToRow(live.value.amendmentId);
    }
  },
);
onMounted(() => void followDebate());

// Only the first load shows skeletons: refetches keep the sheet in place.
const loading = computed(
  () =>
    (sheetFetch.pending.value && !sheet.value) ||
    (agenda.pending.value && !agenda.data.value),
);
const failed = computed(() => Boolean(sheetFetch.error.value) && !sheet.value);
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <CommonEmptyState
      v-if="!allowed"
      icon="i-lucide-shield-x"
      :title="t('controlSheet.forbiddenTitle')"
      :description="t('controlSheet.forbiddenDescription')"
      variant="outline"
    />

    <template v-else>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <h2 class="text-highlighted text-xl font-semibold">
            {{ t("controlSheet.title") }}
          </h2>
          <p class="text-muted max-w-3xl text-sm">
            {{ t("controlSheet.intro") }}
          </p>
        </div>
        <USwitch
          v-model="follow"
          :label="t('controlSheet.follow')"
          :description="t('controlSheet.followHint')"
          class="max-w-xs"
        />
      </div>

      <div v-if="loading" class="space-y-3" role="status">
        <span class="sr-only">{{ t("controlSheet.loading") }}</span>
        <USkeleton
          v-for="n in 4"
          :key="n"
          aria-hidden="true"
          class="h-16 w-full"
        />
      </div>

      <UAlert
        v-else-if="failed"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('controlSheet.loadError')"
        :actions="[
          {
            label: t('controlSheet.retry'),
            color: 'error',
            variant: 'outline',
            onClick: () => refreshSheet(),
          },
        ]"
        role="alert"
      />

      <template v-else>
        <UTabs
          v-model="tab"
          :items="tabItems"
          :content="false"
          variant="link"
          :aria-label="t('controlSheet.tabs.label')"
        />

        <template v-if="tab === 'general'">
          <CommonEmptyState
            v-if="generalRows.length === 0"
            icon="i-lucide-sheet"
            :title="t('controlSheet.emptyTitle')"
            :description="t('controlSheet.emptyDescription')"
            variant="outline"
          />
          <ControlSheetGeneral
            v-else
            :rows="generalRows"
            :document-path="documentPath"
            @open="openItem"
          />
          <div v-if="canEdit">
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-list-plus"
              :label="t('controlSheet.add.button')"
              @click="addOpen = true"
            />
          </div>
        </template>

        <template v-else>
          <CommonEmptyState
            v-if="documentOptions.length === 0"
            icon="i-lucide-file-pen-line"
            :title="t('controlSheet.document.noneTitle')"
            :description="t('controlSheet.document.none')"
            variant="outline"
          />
          <template v-else>
            <UFormField
              :label="t('controlSheet.document.label')"
              class="max-w-xl"
            >
              <USelectMenu
                v-model="selectedDocumentId"
                :items="selectItems"
                value-key="value"
                :search-input="{
                  placeholder: t('controlSheet.document.search'),
                }"
                class="w-full"
              />
            </UFormField>
            <div
              v-if="amendmentsFetch.pending.value && !amendmentsData"
              class="space-y-3"
              role="status"
            >
              <span class="sr-only">{{ t("controlSheet.loading") }}</span>
              <USkeleton
                v-for="n in 3"
                :key="n"
                aria-hidden="true"
                class="h-14 w-full"
              />
            </div>
            <UAlert
              v-else-if="amendmentsFetch.error.value && !amendmentsData"
              color="error"
              variant="subtle"
              icon="i-lucide-circle-alert"
              :title="t('controlSheet.amendmentsLoadError')"
              :actions="[
                {
                  label: t('controlSheet.retry'),
                  color: 'error',
                  variant: 'outline',
                  onClick: () => {
                    void amendmentsFetch.refresh();
                  },
                },
              ]"
              role="alert"
            />
            <p
              v-else-if="amendmentRows.length === 0"
              class="text-muted text-sm"
            >
              {{ t("controlSheet.amendmentsEmpty") }}
            </p>
            <ControlSheetAmendments
              v-else
              :rows="amendmentRows"
              :amendment-path="amendmentPath"
              @open="openAmendment"
            />
          </template>
        </template>
      </template>

      <ControlSheetRowPanel
        v-model:open="panelOpen"
        :target="panelTarget"
        :api-base="apiBase"
        :can="{ edit: canEdit, moderate: canModerate }"
        @item-saved="onItemSaved"
        @amendment-saved="onAmendmentSaved"
      />

      <UModal
        v-model:open="addOpen"
        :title="t('controlSheet.add.title')"
        :description="t('controlSheet.add.description')"
      >
        <template #body>
          <p v-if="addItems.length === 0" class="text-muted text-sm">
            {{ t("controlSheet.add.none") }}
          </p>
          <UFormField v-else :label="t('controlSheet.add.label')">
            <USelectMenu
              v-model="addChoice"
              :items="addItems"
              value-key="value"
              :placeholder="t('controlSheet.add.placeholder')"
              class="w-full"
            />
          </UFormField>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :label="t('common.cancel')"
              @click="addOpen = false"
            />
            <UButton
              icon="i-lucide-list-plus"
              :label="t('controlSheet.add.confirm')"
              :loading="adding"
              :disabled="!addChoice"
              @click="addItem"
            />
          </div>
        </template>
      </UModal>
    </template>
  </div>
</template>
