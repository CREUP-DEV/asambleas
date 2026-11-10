<script setup lang="ts">
import {
  DOCUMENT_FORMATS,
  DOCUMENT_KINDS,
  type DocumentFormat,
  type DocumentKind,
} from "~~/shared/constants/domain";
import type {
  BulkCreatedDocumentDto,
  BulkDocumentsBody,
  BulkDocumentsDto,
  DocumentDto,
  MemberDto,
} from "~~/shared/types/api";
import { BULK_DOCUMENTS_MAX } from "~~/shared/utils/agendaSubmissions";
import { orderMembers } from "~~/shared/utils/memberOrder";
import { memberMayPresent } from "~~/shared/utils/presenterKinds";
import { proposeFromItem } from "~/composables/document/itemProposal";
import {
  BULK_TITLE_MAX,
  bulkErrorIndex,
  bulkFileProblem,
  bulkRowProblems,
  bulkRowsToSend,
  titleFromFileName,
  type BulkRow,
  type BulkRowProblems,
} from "~/utils/bulkDocuments";

/**
 * "Añadir varios documentos": the Secretaría adds several documents to one agenda
 * item without leaving the page. Each line is a document: title, type, who
 * presents it and whether its text is written on the platform or comes as a
 * PDF, which can be dropped on the line.
 *
 * - The type starts on the only kind the item takes, or on what its title
 *   suggests (proposeFromItem); a new line repeats the type and the format
 *   of the one above. A sectorial is never offered for an internal motion.
 * - Lines left blank are not sent. Every line is checked first; then one
 *   request creates all the documents or none (POST .../agenda/[item]/
 *   documents), each with its own sub-item when the item takes documents
 *   from members.
 * - Then each PDF goes to its document (POST .../documents/[id]/file). A
 *   PDF that fails does not undo anything: the documents stay, and the
 *   dialog lists the ones left without their PDF, to try again or to open.
 *
 * Enter in a title goes to the next line (a new one after the last) and
 * never creates the documents: only "Crear" does. Once something is typed,
 * a click outside or Escape no longer closes the dialog, so the list is not
 * lost by accident; "Cancelar" and the close button still discard it.
 *
 * Emits `created` once the documents exist and `uploaded` when the PDFs are
 * done, so the page reloads the agenda.
 */
const props = defineProps<{
  apiBase: string;
  /** Localized hub path ("/asambleas/80-ago"). */
  basePath: string;
  /** The item the documents go under, with its number ("3.2"). */
  item: {
    id: string;
    title: string;
    number: string;
    acceptsSubmissions: boolean;
    submissionKinds: DocumentKind[];
    /** It already shows documents, so no title is proposed from it. */
    hasDocuments: boolean;
  };
}>();

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{
  created: [documents: BulkCreatedDocumentDto[]];
  uploaded: [];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();

type Row = BulkRow<File>;

// Rows --------------------------------------------------------------------------

let nextKey = 1;

/** The kind a new list starts on: the item's only one, or its title's. */
function proposal() {
  const fromTitle = proposeFromItem(props.item);
  const [only] = props.item.submissionKinds;
  return props.item.submissionKinds.length === 1 && only
    ? { ...fromTitle, kind: only }
    : fromTitle;
}

const { member: myMember } = useMe();

/** Who presents a new row by default: the manager's own member, if any. */
function defaultProponent(): string | null {
  return myMember.value?.id ?? null;
}

function firstRow(): Row {
  const proposed = proposal();
  return {
    key: nextKey++,
    title: proposed.title ?? "",
    kind: proposed.kind ?? undefined,
    proponentMemberId: defaultProponent(),
    format: "structured",
    file: null,
  };
}

const rows = ref<Row[]>([firstRow()]);
/** The title the list opened with (proposed from the item), not typed. */
const startTitle = ref(rows.value[0]?.title ?? "");
const full = computed(() => rows.value.length >= BULK_DOCUMENTS_MAX);

async function addRow(): Promise<void> {
  if (full.value) return;
  const last = rows.value.at(-1);
  const row: Row = {
    key: nextKey++,
    title: "",
    kind: last?.kind ?? proposal().kind ?? undefined,
    proponentMemberId: last?.proponentMemberId ?? defaultProponent(),
    format: last?.format ?? "structured",
    file: null,
  };
  rows.value.push(row);
  await nextTick();
  document.getElementById(titleInputId(row.key))?.focus();
}

/**
 * Enter in a title: on to the next line, or a new one after the last. It
 * never sends the form.
 */
function onTitleEnter(event: KeyboardEvent, index: number): void {
  if (event.isComposing) return;
  event.preventDefault();
  const next = rows.value[index + 1];
  if (next) {
    document.getElementById(titleInputId(next.key))?.focus();
  } else if (rows.value[index]?.title.trim()) {
    void addRow();
  }
}

/** Something was typed or chosen that closing the dialog would lose. */
const dirty = computed(
  () =>
    rows.value.length > 1 ||
    rows.value.some(
      (row) =>
        row.file !== null ||
        row.proponentMemberId !== defaultProponent() ||
        row.title.trim() !== startTitle.value.trim(),
    ),
);

function removeRow(key: number): void {
  rows.value =
    rows.value.length > 1
      ? rows.value.filter((row) => row.key !== key)
      : [firstRow()];
  if (refusedKey.value === key) refusedKey.value = null;
}

const baseId = useId();
function titleInputId(key: number): string {
  return `${baseId}-title-${key}`;
}

// Choices -----------------------------------------------------------------------

const kindItems = computed(() =>
  DOCUMENT_KINDS.map((kind: DocumentKind) => ({
    label: t(`agenda.documentKinds.${kind}`),
    value: kind,
  })),
);
const formatItems = computed(() =>
  DOCUMENT_FORMATS.map((format: DocumentFormat) => ({
    label: t(`agenda.formats.${format}`),
    value: format,
  })),
);
const formatUi = { fieldset: "flex-wrap gap-2" };

const members = ref<MemberDto[]>([]);
const membersLoading = ref(false);
const membersFailed = ref(false);

async function loadMembers(): Promise<void> {
  if (members.value.length > 0 || membersLoading.value) return;
  membersLoading.value = true;
  membersFailed.value = false;
  try {
    // Never the generic "CEA": it is not a member anyone presents for. The
    // account's own kind goes first, then the general order.
    members.value = orderMembers(
      addableMembers(await api.get<MemberDto[]>("/api/members")),
      myMember.value?.kind ?? null,
    );
  } catch (error) {
    membersFailed.value = true;
    api.notifyError(error, "agenda.newDocument.membersError");
  } finally {
    membersLoading.value = false;
  }
}

/** Whether a member may present a document of the row's kind. */
function mayPresent(row: Row, candidate: MemberDto): boolean {
  return (
    candidate.active &&
    (!row.kind || memberMayPresent(row.kind, candidate.kind))
  );
}

/** Active members that may present the row's kind. */
function memberItems(row: Row) {
  return [
    ...members.value
      .filter((candidate) => mayPresent(row, candidate))
      .map(memberMenuItem),
  ];
}

function onKind(row: Row, kind: DocumentKind | undefined): void {
  row.kind = kind;
  // A presenter that may not present the new kind is taken off.
  const presenter = members.value.find(
    (candidate) => candidate.id === row.proponentMemberId,
  );
  if (presenter && !mayPresent(row, presenter)) row.proponentMemberId = null;
}

function onProponent(row: Row, value: string | undefined): void {
  row.proponentMemberId = value || null;
  if (refusedKey.value === row.key) refusedKey.value = null;
}

function onFile(row: Row, file: File | null | undefined): void {
  row.file = file ?? null;
  if (file && !row.title.trim() && !bulkFileProblem(file)) {
    row.title = titleFromFileName(file.name);
  }
}

// Validation --------------------------------------------------------------------

/** Errors show from the first try to save on. */
const attempted = ref(false);
/** The row the server refused (who presents it), by key. */
const refusedKey = ref<number | null>(null);

const problems = computed(() => {
  const map = new Map<number, BulkRowProblems>();
  // A PDF of the wrong type or size is said at once, not on saving.
  for (const row of rows.value) {
    const file = row.format === "file" && row.file ? row.file : null;
    const problem = file ? bulkFileProblem(file) : undefined;
    if (problem) map.set(row.key, { file: problem });
  }
  if (attempted.value) {
    for (const row of bulkRowsToSend(rows.value)) {
      map.set(row.key, bulkRowProblems(row));
    }
  }
  return map;
});

function titleError(row: Row): string | undefined {
  const problem = problems.value.get(row.key)?.title;
  if (problem === "required") return t("agenda.newDocument.titleRequired");
  if (problem === "tooLong") {
    return t("agenda.form.tooLong", { max: BULK_TITLE_MAX });
  }
  return undefined;
}
function kindError(row: Row): string | undefined {
  return problems.value.get(row.key)?.kind
    ? t("agenda.newDocument.kindRequired")
    : undefined;
}
function fileError(row: Row): string | undefined {
  const problem = problems.value.get(row.key)?.file;
  return problem ? t(`document.file.${problem}`) : undefined;
}
function proponentError(row: Row): string | undefined {
  if (refusedKey.value === row.key) return t("agenda.bulk.rowRefused");
  return problems.value.get(row.key)?.proponent
    ? t("agenda.newDocument.proponentRequired")
    : undefined;
}

/** How many documents "Crear" will create. */
const sendCount = computed(() => bulkRowsToSend(rows.value).length);

// Saving ------------------------------------------------------------------------

type Phase = "form" | "uploading" | "result";
const phase = ref<Phase>("form");
const saving = ref(false);
const announcement = ref("");

interface PendingUpload {
  document: BulkCreatedDocumentDto;
  file: File;
}
interface FailedUpload extends PendingUpload {
  /** i18n key of why it failed. */
  reason: string;
}

const uploadProgress = ref({ done: 0, total: 0 });
const failedUploads = ref<FailedUpload[]>([]);
const busy = computed(() => saving.value || phase.value === "uploading");

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    rows.value = [firstRow()];
    startTitle.value = rows.value[0]?.title ?? "";
    attempted.value = false;
    refusedKey.value = null;
    phase.value = "form";
    failedUploads.value = [];
    announcement.value = "";
    void loadMembers();
  },
  { immediate: true },
);

async function submit(): Promise<void> {
  if (busy.value) return;
  attempted.value = true;
  refusedKey.value = null;
  const sending = bulkRowsToSend(rows.value);
  const invalid = sending.find(
    (row) => Object.keys(bulkRowProblems(row)).length > 0,
  );
  if (invalid || sending.length === 0) {
    announcement.value = t("agenda.bulk.fixRows");
    if (invalid) document.getElementById(titleInputId(invalid.key))?.focus();
    return;
  }

  const body: BulkDocumentsBody = {
    documents: sending.map((row) => ({
      title: row.title.trim(),
      // Checked above: every row sent has its kind.
      kind: row.kind as DocumentKind,
      format: row.format,
      proponentMemberId: row.proponentMemberId,
    })),
  };
  saving.value = true;
  let created: BulkCreatedDocumentDto[];
  try {
    const result = await api.send<BulkDocumentsDto>(
      `${props.apiBase}/agenda/${encodeURIComponent(props.item.id)}/documents`,
      { method: "POST", body },
    );
    created = result.documents;
  } catch (error) {
    // Nothing was created. A refusal about one row marks that row.
    const index = bulkErrorIndex(error);
    const refused =
      index !== null && api.errorStatus(error) === 422
        ? sending[index]
        : sending.length === 1 && api.errorStatus(error) === 422
          ? sending[0]
          : undefined;
    if (refused) {
      refusedKey.value = refused.key;
      announcement.value = t("agenda.bulk.fixRows");
    }
    api.notifyError(error, "agenda.bulk.error");
    return;
  } finally {
    saving.value = false;
  }

  emit("created", created);
  const uploads: PendingUpload[] = [];
  sending.forEach((row, index) => {
    const document = created[index];
    if (document && row.format === "file" && row.file) {
      uploads.push({ document, file: row.file });
    }
  });
  await runUploads(uploads, created.length);
}

/** Why an upload failed, as an i18n key. */
function uploadReason(error: unknown): string {
  const status = api.errorStatus(error);
  if (status === 415) return "document.file.invalidType";
  if (status === 413) return "document.file.tooLarge";
  return "document.file.error";
}

/**
 * Uploads each PDF to its document, one at a time. A failure leaves that
 * document without PDF and goes on with the next one.
 */
async function runUploads(
  uploads: PendingUpload[],
  createdCount: number,
): Promise<void> {
  const failed: FailedUpload[] = [];
  if (uploads.length > 0) {
    phase.value = "uploading";
    uploadProgress.value = { done: 0, total: uploads.length };
    for (const upload of uploads) {
      try {
        const body = new FormData();
        body.append("file", upload.file, upload.file.name);
        await api.send<DocumentDto>(
          `${props.apiBase}/documents/${encodeURIComponent(upload.document.id)}/file`,
          { body },
        );
      } catch (error) {
        failed.push({ ...upload, reason: uploadReason(error) });
      }
      uploadProgress.value = {
        done: uploadProgress.value.done + 1,
        total: uploads.length,
      };
    }
    emit("uploaded");
  }
  failedUploads.value = failed;
  if (failed.length > 0) {
    phase.value = "result";
    announcement.value = t("agenda.bulk.uploadFailedTitle");
    return;
  }
  phase.value = "form";
  open.value = false;
  if (createdCount > 0) {
    toast.add({
      title: t("agenda.bulk.created", { count: createdCount }, createdCount),
      color: "success",
      icon: "i-lucide-files",
    });
  } else {
    toast.add({
      title: t("document.file.uploaded"),
      color: "success",
      icon: "i-lucide-check",
    });
  }
}

/** Tries again the PDFs that failed; the documents already exist. */
async function retryUploads(): Promise<void> {
  if (busy.value) return;
  await runUploads(
    failedUploads.value.map(({ document, file }) => ({ document, file })),
    0,
  );
}

function editorPath(document: BulkCreatedDocumentDto): string {
  return `${props.basePath}/documentos/${encodeURIComponent(document.slug)}/editar`;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('agenda.bulk.title')"
    :description="
      t('agenda.newDocument.under', {
        number: item.number,
        title: item.title,
      })
    "
    :dismissible="!busy && !(phase === 'form' && dirty)"
    :close="!busy"
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <template #body>
      <!-- The documents exist; some PDFs did not go up -->
      <div v-if="phase === 'result'" class="space-y-4">
        <UAlert
          color="warning"
          variant="subtle"
          icon="i-lucide-file-warning"
          :title="t('agenda.bulk.uploadFailedTitle')"
          :description="t('agenda.bulk.uploadFailedDescription')"
        />
        <ul class="space-y-2" data-testid="agenda-bulk-failed">
          <li
            v-for="failure in failedUploads"
            :key="failure.document.id"
            class="border-default flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border p-3"
          >
            <div class="min-w-0 flex-1">
              <p class="text-highlighted text-sm font-medium break-words">
                {{ failure.document.title }}
              </p>
              <p class="text-muted text-sm">
                {{ failure.file.name }} · {{ t(failure.reason) }}
              </p>
            </div>
            <UButton
              :to="editorPath(failure.document)"
              color="neutral"
              variant="outline"
              size="sm"
              icon="i-lucide-file-up"
              :label="t('agenda.bulk.openDocument')"
            />
          </li>
        </ul>
      </div>

      <!-- Uploading the PDFs -->
      <p
        v-else-if="phase === 'uploading'"
        class="text-muted flex items-center gap-2 text-sm"
        role="status"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-4 shrink-0 animate-spin"
          aria-hidden="true"
        />
        {{ t("agenda.bulk.uploading", uploadProgress) }}
      </p>

      <form
        v-else
        id="agenda-bulk-documents-form"
        class="space-y-4"
        novalidate
        @submit.prevent="submit"
      >
        <p class="text-muted text-sm">
          {{ t("agenda.bulk.intro") }}
          <template v-if="item.acceptsSubmissions">
            {{ t("agenda.bulk.containerHint") }}
          </template>
        </p>

        <ol class="space-y-3" :aria-label="t('agenda.bulk.title')">
          <li v-for="(row, index) in rows" :key="row.key">
            <fieldset
              class="border-default space-y-3 rounded-lg border p-3"
              :disabled="saving"
              :data-bulk-row="index"
            >
              <legend class="sr-only">
                {{ t("agenda.bulk.row", { n: index + 1 }) }}
              </legend>
              <div class="flex items-center justify-between gap-2">
                <span
                  class="text-muted text-xs font-medium tabular-nums"
                  aria-hidden="true"
                >
                  {{ t("agenda.bulk.row", { n: index + 1 }) }}
                </span>
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="xs"
                  icon="i-lucide-x"
                  :label="t('agenda.bulk.removeRow')"
                  :aria-label="t('agenda.bulk.removeRowN', { n: index + 1 })"
                  @click="removeRow(row.key)"
                />
              </div>

              <UFormField
                :label="t('agenda.newDocument.documentTitle')"
                :error="titleError(row)"
                required
              >
                <UInput
                  :id="titleInputId(row.key)"
                  v-model="row.title"
                  :maxlength="BULK_TITLE_MAX"
                  class="w-full"
                  @keydown.enter="onTitleEnter($event, index)"
                />
              </UFormField>

              <div class="grid gap-3 sm:grid-cols-2">
                <UFormField
                  :label="t('agenda.newDocument.kind')"
                  :error="kindError(row)"
                  required
                >
                  <USelectMenu
                    :model-value="row.kind"
                    :items="kindItems"
                    value-key="value"
                    :placeholder="t('agenda.newDocument.kindPlaceholder')"
                    :aria-label="
                      selectMenuLabel(
                        t('agenda.newDocument.kind'),
                        kindItems,
                        row.kind,
                        t('agenda.newDocument.kindPlaceholder'),
                      )
                    "
                    :search-input="
                      labelledSearch(t('agenda.newDocument.searchKind'))
                    "
                    class="w-full"
                    @update:model-value="onKind(row, $event)"
                  />
                </UFormField>
                <UFormField
                  :label="t('agenda.newDocument.proponent')"
                  :error="proponentError(row)"
                  :help="
                    membersFailed
                      ? t('agenda.newDocument.membersError')
                      : undefined
                  "
                >
                  <USelectMenu
                    :model-value="row.proponentMemberId ?? undefined"
                    :items="memberItems(row)"
                    value-key="value"
                    :ui="MEMBER_MENU_UI"
                    :filter-fields="MEMBER_MENU_FILTER_FIELDS"
                    :loading="membersLoading"
                    :placeholder="t('agenda.newDocument.proponentPlaceholder')"
                    :aria-label="
                      selectMenuLabel(
                        t('agenda.newDocument.proponent'),
                        memberItems(row),
                        row.proponentMemberId ?? undefined,
                      )
                    "
                    :search-input="
                      labelledSearch(t('agenda.newDocument.searchMember'))
                    "
                    class="w-full"
                    @update:model-value="onProponent(row, $event)"
                  >
                    <template #default="{ modelValue, ui }">
                      <CommonMenuValue
                        :items="memberItems(row)"
                        :value="modelValue"
                        :placeholder="
                          t('agenda.newDocument.proponentPlaceholder')
                        "
                        :ui="ui"
                      />
                    </template>
                  </USelectMenu>
                </UFormField>
              </div>

              <UFormField :label="t('agenda.newDocument.format')">
                <URadioGroup
                  v-model="row.format"
                  :items="formatItems"
                  value-key="value"
                  orientation="horizontal"
                  variant="card"
                  size="sm"
                  :ui="formatUi"
                />
              </UFormField>

              <UFormField
                v-if="row.format === 'file'"
                :label="t('agenda.bulk.file')"
                :hint="t('agenda.newDocument.optional')"
                :error="fileError(row)"
              >
                <UFileUpload
                  :model-value="row.file"
                  accept="application/pdf,.pdf"
                  variant="area"
                  layout="list"
                  size="sm"
                  icon="i-lucide-upload"
                  :label="t('agenda.bulk.fileLabel')"
                  :description="t('agenda.bulk.fileDescription')"
                  class="w-full"
                  @update:model-value="onFile(row, $event)"
                />
              </UFormField>
            </fieldset>
          </li>
        </ol>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-plus"
            :label="t('agenda.bulk.addRow')"
            :disabled="full || saving"
            data-testid="agenda-bulk-add-row"
            @click="addRow"
          />
          <p v-if="full" class="text-muted text-sm">
            {{ t("agenda.bulk.maxRows", { max: BULK_DOCUMENTS_MAX }) }}
          </p>
        </div>
      </form>

      <p class="sr-only" aria-live="polite" role="status">
        {{ announcement }}
      </p>
    </template>

    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <template v-if="phase === 'result'">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.close')"
            @click="open = false"
          />
          <UButton
            icon="i-lucide-refresh-ccw"
            :label="t('agenda.bulk.retry')"
            @click="retryUploads"
          />
        </template>
        <template v-else>
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="busy"
            @click="open = false"
          />
          <UButton
            type="submit"
            form="agenda-bulk-documents-form"
            icon="i-lucide-files"
            :label="t('agenda.bulk.submit', { count: sendCount }, sendCount)"
            :loading="busy"
            data-testid="agenda-bulk-submit"
          />
        </template>
      </div>
    </template>
  </UModal>
</template>
