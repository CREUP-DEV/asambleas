<script setup lang="ts">
import type { DocumentDto, DocumentSummaryDto } from "~~/shared/types/api";
import { kindAcceptsFile } from "~~/shared/utils/documentFormat";
import {
  amendDocumentPath,
  unreadAmendmentsPath,
} from "~/composables/document/documentLinks";
import { isDocumentLiveBatch } from "~/composables/document/useDocument";

/**
 * The published documents of an agenda item, read in place: one on show at
 * a time, the PDF in the browser's viewer or the text as it was published,
 * so going through an item's documents never needs a page each.
 *
 * - With several documents, a row of tabs (each with its read mark); past
 *   ITEM_READER_MAX_TABS, "Documento 2 de 7" and a menu instead. Only the
 *   one on show is fetched; the ones already seen stay in memory.
 * - The one on show is in the address (`?doc=<slug>`), so its link can be
 *   shared and Back walks the documents read.
 * - The page shows over its title the reading bar of a document's page
 *   (DocumentReadBar) for the one on show: position among all the
 *   documents, what is left to read, "Marcar como leído", and "Anterior" /
 *   "Siguiente" in the order of the whole agenda, which open the document
 *   in its item's reader: past the item's last one comes the first of the
 *   next item.
 * - Reading only: the text shows clean, with no amendment marks. What the
 *   document holds besides (its amendments, the editor) is one button away,
 *   on the document's page: always "Ver enmiendas" (when it has any) or
 *   "Abrir documento", and "Presentar enmienda" (where the reader was) for
 *   whoever may amend it.
 *   The header with them stays in view while the document scrolls (from
 *   `sm` up; on a phone it would take too much of the screen).
 *
 * Phones get the PDF as a card with its button (DocumentPdfViewer) and the
 * text in place. The embedded viewer has no "open in a new tab" of its own
 * here: the room goes to the document.
 */
const props = defineProps<{
  itemId: string;
  /** Every published document of the assembly, in the order of the agenda. */
  ordered: DocumentSummaryDto[];
  /** The page of an agenda item, by its id. */
  itemPath: (itemId: string) => string;
  documentPath: (document: DocumentSummaryDto) => string;
}>();

const { t } = useI18n();
const api = useApi();
const route = useRoute();
const { apiBase, onLive } = useCurrentAssembly();
const marks = useReadMarks();

const wanted = computed(() => {
  const value = route.query[ITEM_READER_QUERY];
  return typeof value === "string" && value ? value : null;
});
const position = computed(() =>
  itemReaderPosition(props.ordered, props.itemId, wanted.value),
);
const current = computed(() => position.value.current);
const here = computed(() => position.value.here);

/** The reader on a document: its item's page, with the document named. */
function readerPath(document: DocumentSummaryDto) {
  return {
    path: props.itemPath(document.agendaItemId),
    query: { [ITEM_READER_QUERY]: document.slug },
  };
}

// The document on show -------------------------------------------------------------

/** The documents fetched so far, by id. */
const loaded = shallowRef<ReadonlyMap<string, DocumentDto>>(new Map());
const failed = ref<string | null>(null);
const detail = computed(() =>
  current.value ? (loaded.value.get(current.value.id) ?? null) : null,
);

/** Requests on their way, so one document is never asked for twice at once. */
const loading = new Set<string>();

async function load(id: string): Promise<void> {
  if (loading.has(id)) return;
  loading.add(id);
  failed.value = null;
  try {
    const dto = await api.get<DocumentDto>(
      `${apiBase.value}/documents/${encodeURIComponent(id)}`,
    );
    loaded.value = new Map(loaded.value).set(id, dto);
  } catch {
    // The one on show says so, with a way to try again.
    if (current.value?.id === id && !loaded.value.has(id)) failed.value = id;
  } finally {
    loading.delete(id);
  }
}

onMounted(() => {
  watch(
    () => current.value?.id,
    (id) => {
      failed.value = null;
      if (id && !loaded.value.has(id)) void load(id);
    },
    { immediate: true },
  );
});

// A document that changes: the one on show is read again in place, the
// others when they are next opened.
onLive((events) => {
  const stale = [...loaded.value.keys()].filter((id) =>
    isDocumentLiveBatch(events, id),
  );
  if (stale.length === 0) return;
  const shown = current.value?.id;
  const kept = new Map(loaded.value);
  for (const id of stale) if (id !== shown) kept.delete(id);
  loaded.value = kept;
  if (shown && stale.includes(shown)) void load(shown);
});

const blocks = computed(() => detail.value?.baseVersion?.blocks ?? []);

// What the header says ---------------------------------------------------------------

const documentWindow = useDocumentWindow(
  () => current.value ?? props.ordered[0]!,
);
const amendmentsLeft = computed(() =>
  current.value
    ? (marks.index.value.amendmentsLeft.get(current.value.id) ?? 0)
    : 0,
);
const showAmendments = computed(
  () =>
    Boolean(current.value) &&
    (current.value!.amendable || current.value!.amendmentCount > 0),
);

/** May present an amendment now: the editor opens on the document's page. */
const canAmend = computed(
  () =>
    Boolean(detail.value?.can.amend) &&
    detail.value?.format === "structured" &&
    blocks.value.length > 0 &&
    !detail.value?.finalVote,
);

const textView = useTemplateRef<{ root: HTMLElement | null }>("textView");
const headerEl = useTemplateRef<HTMLElement>("headerEl");

/**
 * The paragraph the reader has on top: the first one that reaches below the
 * document's header, which stays in view over the text on wide screens.
 */
function readingBlockId(): string | null {
  const root = textView.value?.root;
  if (!root) return null;
  const top = Math.max(headerEl.value?.getBoundingClientRect().bottom ?? 0, 0);
  for (const element of root.querySelectorAll<HTMLElement>("[data-block-id]")) {
    const box = element.getBoundingClientRect();
    if (box.height > 0 && box.bottom > top + 8) {
      return element.dataset.blockId ?? null;
    }
  }
  return null;
}

/** "Presentar enmienda": the editor, at the paragraph the reader had on top. */
function amendPath(): string {
  return amendDocumentPath(
    props.documentPath(current.value!),
    readingBlockId(),
  );
}

// Picking a document -------------------------------------------------------------------

/** Whether a tab shows a read mark: never on the member's own documents. */
function hasReadMark(id: string): boolean {
  const mark = marks.document(id);
  return mark !== null && !mark.own;
}

const asTabs = computed(() => here.value.length <= ITEM_READER_MAX_TABS);
const menuItems = computed(() =>
  here.value.map((document) => ({
    label: document.title,
    value: document.slug,
  })),
);
function pick(slug: unknown): void {
  const target = here.value.find((document) => document.slug === slug);
  if (target) void navigateTo(readerPath(target));
}
</script>

<template>
  <div v-if="current" class="space-y-3" data-testid="item-reader">
    <!-- Which document, when the item has several -->
    <nav
      v-if="here.length > 1"
      class="flex flex-wrap items-center gap-2"
      :aria-label="t('agenda.reader.label')"
      data-testid="item-reader-documents"
    >
      <template v-if="asTabs">
        <NuxtLink
          v-for="document in here"
          :key="document.id"
          :to="readerPath(document)"
          class="focus-visible:outline-primary inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
          :class="
            document.id === current.id
              ? 'border-primary bg-primary/5 text-highlighted font-medium'
              : 'border-default text-default hover:bg-elevated/60'
          "
          :aria-current="document.id === current.id ? 'page' : undefined"
        >
          <!-- Read or not; a document that takes no mark (the member's
               own, or before the marks load) shows what it is instead. -->
          <ReadMark
            v-if="hasReadMark(document.id)"
            kind="document"
            :state="marks.document(document.id)?.state"
          />
          <UIcon
            v-else
            :name="
              document.format === 'file'
                ? 'i-lucide-file-text'
                : 'i-lucide-file-pen-line'
            "
            class="text-muted size-4 shrink-0"
            aria-hidden="true"
          />
          <span class="line-clamp-1 break-words">{{ document.title }}</span>
        </NuxtLink>
      </template>
      <template v-else>
        <span class="text-default text-sm font-medium tabular-nums">
          {{
            t("readMarks.bar.position", {
              index: position.index + 1,
              total: here.length,
            })
          }}
        </span>
        <USelectMenu
          :model-value="current.slug"
          :items="menuItems"
          value-key="value"
          size="sm"
          class="max-w-full min-w-0 flex-1 sm:max-w-md"
          :search-input="false"
          :aria-label="t('agenda.reader.choose')"
          @update:model-value="pick"
        />
      </template>
    </nav>

    <article
      class="border-default rounded-lg border"
      :aria-labelledby="`item-reader-title-${current.id}`"
    >
      <!-- Kept in view over the document on wide screens, so marking it as
           read or amending it never needs scrolling back up. The negative
           offset is the padding of the hub's scroll area, which sticky
           positioning leaves out: without it the text would show through
           a strip above the header. -->
      <header
        ref="headerEl"
        class="border-default bg-default z-10 flex flex-col gap-3 rounded-t-lg border-b p-3 sm:sticky sm:-top-6 sm:flex-row sm:items-start sm:justify-between sm:p-4"
      >
        <div class="min-w-0 space-y-1.5">
          <h4
            :id="`item-reader-title-${current.id}`"
            class="text-highlighted font-semibold break-words sm:text-lg"
          >
            <NuxtLink
              :to="documentPath(current)"
              class="focus-visible:outline-primary rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              data-testid="item-reader-title"
            >
              {{ current.title }}
            </NuxtLink>
          </h4>
          <div
            class="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
          >
            <span>{{ t(`agenda.documentKinds.${current.kind}`) }}</span>
            <template v-if="current.reference">
              <span aria-hidden="true">·</span>
              <span class="tabular-nums">{{ current.reference }}</span>
            </template>
            <template v-if="current.proponent">
              <span aria-hidden="true">·</span>
              <DocumentPresenters :document="current" :max-others="2" />
            </template>
          </div>
          <!-- Its amendments: how many, how many left to read, the window -->
          <div
            v-if="showAmendments"
            class="text-muted flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
            data-testid="item-reader-amendments"
          >
            <span class="inline-flex items-center gap-1">
              <UIcon
                name="i-lucide-message-square-diff"
                class="size-4 shrink-0"
                aria-hidden="true"
              />
              {{
                t(
                  "agenda.document.amendments",
                  { count: current.amendmentCount },
                  current.amendmentCount,
                )
              }}
            </span>
            <template v-if="amendmentsLeft > 0">
              <span aria-hidden="true">·</span>
              <ULink
                :to="unreadAmendmentsPath(documentPath(current))"
                class="text-primary hover:underline"
                data-testid="item-reader-unread"
              >
                {{
                  t(
                    "readMarks.amendmentsHere",
                    { count: amendmentsLeft },
                    amendmentsLeft,
                  )
                }}
              </ULink>
            </template>
            <template v-if="documentWindow.countdown.value">
              <span aria-hidden="true">·</span>
              <CommonCountdown
                :to="documentWindow.countdown.value.at"
                :label="documentWindow.countdown.value.label"
                icon="i-lucide-timer"
                :urgent-hours="48"
              />
            </template>
            <template v-else-if="documentWindow.closed.value">
              <span aria-hidden="true">·</span>
              <span class="inline-flex items-center gap-1">
                <UIcon
                  name="i-lucide-lock"
                  class="size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {{ t("agenda.document.windowClosed") }}
              </span>
            </template>
          </div>
        </div>

        <div class="flex shrink-0 flex-wrap items-center gap-2">
          <!-- Always the way to the document's page, named after what is
               there to see; and, for whoever may amend it, the editor. -->
          <UButton
            :to="documentPath(current)"
            size="sm"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-arrow-right"
            :label="
              current.amendmentCount > 0
                ? t('agenda.reader.viewAmendments')
                : t('agenda.reader.open')
            "
            data-testid="item-reader-open"
          />
          <UButton
            v-if="canAmend"
            size="sm"
            icon="i-lucide-pencil-line"
            :label="t('workspace.cta.present')"
            data-testid="item-reader-amend"
            @click="navigateTo(amendPath())"
          />
        </div>
      </header>

      <div class="p-3 sm:p-4">
        <!-- Could not be read -->
        <UAlert
          v-if="failed === current.id"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          role="alert"
          :title="t('agenda.reader.loadError')"
          :actions="[
            {
              label: t('agenda.retry'),
              icon: 'i-lucide-refresh-ccw',
              color: 'neutral',
              variant: 'outline',
              onClick: () => {
                void load(current!.id);
              },
            },
          ]"
        />

        <div v-else-if="!detail" class="space-y-3" role="status">
          <span class="sr-only">{{ t("agenda.reader.loading") }}</span>
          <USkeleton aria-hidden="true" class="h-5 w-2/3" />
          <USkeleton aria-hidden="true" class="h-64 w-full" />
        </div>

        <template v-else>
          <p
            v-if="detail.summary"
            class="text-muted mb-4 max-w-3xl text-sm whitespace-pre-line"
          >
            {{ detail.summary }}
          </p>

          <DocumentPdfViewer
            v-if="detail.format === 'file'"
            :key="detail.id"
            :url="detail.fileUrl"
            :title="detail.title"
            :description="
              kindAcceptsFile(detail.kind)
                ? undefined
                : t('workspace.text.fileDescription')
            "
            :pending-description="t('workspace.text.filePending')"
            :open-button="false"
          />

          <!-- The text keeps the editor's measure, centred -->
          <div
            v-else-if="blocks.length > 0"
            class="mx-auto max-w-[52rem]"
            data-testid="item-reader-text"
          >
            <ContentView ref="textView" :key="detail.id" :blocks="blocks" />
          </div>

          <p v-else class="text-muted text-sm">
            {{ t("workspace.text.empty") }}
          </p>
        </template>
      </div>
    </article>
  </div>
</template>
