<script setup lang="ts">
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type {
  AgreementsRecordDto,
  AgreementRecordTextBody,
} from "~~/shared/types/api";
import type {
  RecordAgreement,
  RecordHeaderKey,
} from "~~/shared/utils/agreementsRecord";
import { RECORD_HEADER_KEYS } from "~~/shared/utils/agreementsRecord";
import {
  headerNeedsSave,
  releaseHeaderDraft,
  syncHeaderDrafts,
} from "~/components/agreements-record/-headerDrafts";

/**
 * The acta de acuerdos (document:manage; user's decisions of 2026-11-21):
 * the record the platform words from the votes, as CREUP's record of the
 * 79.ª AGO, for the Secretaría to create once under the agenda item where
 * it is read and approved, and to correct line by line. The corrections
 * are kept apart from the text, so every vote writes it again without
 * losing them; its own final vote settles it. Once approved it is signed
 * (SigningPanel), and a correction then regenerates it.
 */

const { t } = useI18n();
const { can } = useMe();
const api = useApi();
const toast = useToast();
const current = useCurrentAssembly();
const { assembly, apiBase, sectionPath, onLive } = current;

useHead({
  title: () =>
    [t("agreementsRecord.title"), assembly.value?.label]
      .filter(Boolean)
      .join(" · "),
});

const allowed = computed(() => can(PERMISSION_KEYS.DOCUMENT_MANAGE));

const {
  data: record,
  pending,
  error,
  refresh,
} = await useFetch<AgreementsRecordDto>(
  () => `${apiBase.value}/agreements-record`,
  {
    key: computed(() => `agreements-record-${assembly.value?.id ?? "none"}`),
    immediate: allowed.value,
    dedupe: "defer",
  },
);

// Every vote may change an agreement: read it again once a burst settles
// (the server writes the document a moment after the change).
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
const stopLive = onLive(() => {
  if (!allowed.value) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refresh();
  }, 2_500);
});
onScopeDispose(() => {
  stopLive();
  if (refreshTimer) clearTimeout(refreshTimer);
});

const { data: agenda } = await useAssemblyAgenda();

/** The items the record may go under, the one that names it first. */
const itemOptions = computed(() =>
  flattenAgendaTree(buildAgendaTree(agenda.value?.items ?? []))
    .filter((node) => !node.item.auto)
    .map((node) => ({
      value: node.item.id,
      label: numberedAgendaTitle(
        node.number,
        node.item.title,
        t("agenda.unlisted.inText"),
      ),
      title: node.item.title,
    })),
);
const itemChoice = ref<string | undefined>(undefined);
watchEffect(() => {
  if (itemChoice.value) return;
  itemChoice.value = itemOptions.value.find((option) =>
    /acta\s+de\s+acuerdos/i.test(option.title),
  )?.value;
});

const creating = ref(false);
async function create(): Promise<void> {
  if (!itemChoice.value || creating.value) return;
  creating.value = true;
  try {
    record.value = await api.send<AgreementsRecordDto>(
      `${apiBase.value}/agreements-record`,
      { method: "POST", body: { agendaItemId: itemChoice.value } },
    );
    toast.add({
      title: t("agreementsRecord.created"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (failure) {
    api.notifyError(failure, "agreementsRecord.createFailed");
    void refresh();
  } finally {
    creating.value = false;
  }
}

/**
 * The corrections on their way, sent one after another (each reads its lock
 * as it goes), so none is dropped while another saves and no field has to
 * be disabled, which would throw the keyboard's focus to the page (E-157).
 */
const savingKeys = ref<string[]>([]);
let saves: Promise<void> = Promise.resolve();
function isSaving(key: string): boolean {
  return savingKeys.value.includes(key);
}
function saveText(
  key: string,
  correction: { text: string | null; omitted: boolean },
): Promise<void> {
  savingKeys.value = [...savingKeys.value, key];
  saves = saves.then(() => sendText(key, correction));
  return saves;
}

const agreementsHeading = useTemplateRef<HTMLElement>("agreementsHeading");
async function sendText(
  key: string,
  correction: { text: string | null; omitted: boolean },
): Promise<void> {
  const body: AgreementRecordTextBody = {
    key,
    text: correction.text,
    omitted: correction.omitted,
    updatedAt: record.value?.locks[key] ?? null,
  };
  try {
    record.value = await api.send<AgreementsRecordDto>(
      `${apiBase.value}/agreements-record/texts`,
      { method: "PUT", body },
    );
    toast.add({
      title: record.value?.document?.outdated
        ? t("agreementsRecord.savedPending")
        : t("agreementsRecord.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
    // The record's own line left out leaves the list with its button.
    if (key === "self" && correction.omitted) {
      void nextTick(() => {
        const active = document.activeElement;
        if (!active || active === document.body) {
          agreementsHeading.value?.focus();
        }
      });
    }
  } catch (failure) {
    api.notifyError(failure, "agreementsRecord.saveFailed");
    // Someone else saved first: the field shows their words, as the
    // conflict's notice says, instead of resending the refused ones.
    if (api.isConflict(failure) && isHeaderKey(key)) {
      releaseHeaderDraft(headerDrafts, headerSynced, key);
    }
    void refresh();
  } finally {
    const at = savingKeys.value.indexOf(key);
    savingKeys.value = savingKeys.value.filter((_, index) => index !== at);
  }
}

const frozen = computed(() => Boolean(record.value?.document?.frozen));
/**
 * Corrections stay open once approved: they wait for «Regenerar» (the
 * signing section) instead of changing the text at once. A rejected
 * record is settled.
 */
const readonly = computed(
  () => frozen.value && !record.value?.document?.approved,
);
const documentPath = computed(() =>
  record.value?.document
    ? sectionPath(
        `documentos/${encodeURIComponent(record.value.document.slug)}`,
      )
    : null,
);

/**
 * The header's fields, each corrected like a line. A save of one field
 * leaves the others' drafts alone (syncHeaderDrafts).
 */
const headerDrafts = reactive<Record<RecordHeaderKey, string>>({
  secretary_name: "",
  secretary_title: "",
  city: "",
});
const headerSynced: Partial<Record<RecordHeaderKey, string>> = {};
function isHeaderKey(key: string): key is RecordHeaderKey {
  return (RECORD_HEADER_KEYS as readonly string[]).includes(key);
}
watch(
  () => record.value?.record.header,
  (fields) => syncHeaderDrafts(headerDrafts, headerSynced, fields ?? []),
  { immediate: true },
);
/** The words on their way per field, so Enter and leaving send them once. */
const headerPending = new Map<RecordHeaderKey, string>();
function saveHeader(key: RecordHeaderKey): void {
  const corrected =
    record.value?.record.header.find((field) => field.key === key)?.corrected ??
    null;
  if (!headerNeedsSave(headerDrafts[key], corrected, headerPending.get(key))) {
    return;
  }
  const words = headerDrafts[key].trim();
  headerPending.set(key, words);
  void saveText(key, { text: words || null, omitted: false }).finally(() => {
    if (headerPending.get(key) === words) headerPending.delete(key);
  });
}

const visible = computed(() =>
  (record.value?.record.agreements ?? []).filter(
    (agreement) => agreement.key !== "self" || !agreement.omitted,
  ),
);

function lineLabel(agreement: RecordAgreement): string | null {
  return agreement.number === null ? null : `${agreement.number}.`;
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
/** «a)», «b)»… over the lines not left out. */
function letters(agreement: RecordAgreement): (string | null)[] {
  let index = 0;
  return agreement.lines.map((line) =>
    line.omitted ? null : `${LETTERS[index++ % LETTERS.length]})`,
  );
}
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <CommonEmptyState
      v-if="!allowed"
      icon="i-lucide-shield-x"
      :title="t('agreementsRecord.forbiddenTitle')"
      :description="t('agreementsRecord.forbiddenDescription')"
      variant="outline"
    />

    <template v-else>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <h2 class="text-highlighted text-xl font-semibold">
            {{ t("agreementsRecord.title") }}
          </h2>
          <p class="text-muted max-w-3xl text-sm">
            {{ t("agreementsRecord.intro") }}
          </p>
        </div>
        <UButton
          v-if="documentPath"
          color="neutral"
          variant="outline"
          icon="i-lucide-file-text"
          :label="t('agreementsRecord.openDocument')"
          :to="documentPath"
        />
      </div>

      <CommonEmptyState
        v-if="error && !record"
        icon="i-lucide-triangle-alert"
        :title="t('agreementsRecord.loadFailed')"
        variant="outline"
      >
        <template #action>
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-refresh-cw"
            :label="t('agreementsRecord.retry')"
            :loading="pending"
            @click="refresh()"
          />
        </template>
      </CommonEmptyState>

      <template v-else-if="record">
        <UAlert
          v-if="frozen"
          color="info"
          variant="subtle"
          icon="i-lucide-lock"
          :title="
            record.document?.approved
              ? t('agreementsRecord.frozenApproved')
              : t('agreementsRecord.frozen')
          "
        />

        <SigningPanel
          v-if="record.document"
          :signing="record.signing"
          :approved="record.document.approved"
          :title="record.document.title"
          :base="`${apiBase}/agreements-record/signing`"
          :not-yet="t('agreementsRecord.signing.notYet')"
          :intro="t('agreementsRecord.signing.intro')"
          :outdated="record.document.outdated"
          :regenerate-url="`${apiBase}/agreements-record/regenerate`"
          @update="record = $event as AgreementsRecordDto"
          @stale="refresh()"
        />

        <section
          v-if="!record.document"
          class="border-default space-y-3 rounded-lg border p-4"
        >
          <h3 class="text-highlighted font-semibold">
            {{ t("agreementsRecord.createTitle") }}
          </h3>
          <p class="text-muted text-sm">
            {{ t("agreementsRecord.createDescription") }}
          </p>
          <div class="flex flex-wrap items-end gap-2">
            <UFormField
              :label="t('agreementsRecord.createItem')"
              class="min-w-0 flex-1"
            >
              <USelectMenu
                v-model="itemChoice"
                :items="itemOptions"
                value-key="value"
                :search-input="
                  labelledSearch(t('agenda.newDocument.searchItem'))
                "
                :aria-label="
                  selectMenuLabel(
                    t('agreementsRecord.createItem'),
                    itemOptions,
                    itemChoice,
                  )
                "
                class="w-full"
              />
            </UFormField>
            <UButton
              icon="i-lucide-file-plus-2"
              :label="t('agreementsRecord.create')"
              :loading="creating"
              :disabled="!itemChoice"
              @click="create"
            />
          </div>
        </section>

        <section class="space-y-3">
          <h3 class="text-highlighted font-semibold">
            {{ t("agreementsRecord.headerTitle") }}
          </h3>
          <div class="grid gap-3 sm:grid-cols-3">
            <UFormField
              v-for="field in record.record.header"
              :key="field.key"
              :label="t(`agreementsRecord.header.${field.key}`)"
            >
              <UInput
                v-model="headerDrafts[field.key]"
                :placeholder="field.proposed"
                :disabled="readonly"
                :loading="isSaving(field.key)"
                trailing
                class="w-full"
                @keydown.enter="saveHeader(field.key)"
                @blur="saveHeader(field.key)"
              />
            </UFormField>
          </div>
        </section>

        <section class="space-y-3">
          <h3
            ref="agreementsHeading"
            tabindex="-1"
            class="text-highlighted font-semibold outline-none"
          >
            {{ t("agreementsRecord.agreementsTitle") }}
          </h3>
          <p v-if="visible.length === 0" class="text-muted text-sm">
            {{ t("agreementsRecord.empty") }}
          </p>
          <ol v-else class="divide-default divide-y">
            <li
              v-for="agreement in visible"
              :key="agreement.key"
              class="space-y-2 py-3"
            >
              <AgreementsRecordLine
                :line="agreement"
                :label="lineLabel(agreement)"
                :saving="isSaving(agreement.key)"
                :readonly="readonly"
                @save="saveText(agreement.key, $event)"
              />
              <div
                v-if="agreement.lines.length > 0"
                class="space-y-2 ps-4 sm:ps-8"
              >
                <AgreementsRecordLine
                  v-for="(line, index) in agreement.lines"
                  :key="line.key"
                  :line="line"
                  :label="letters(agreement)[index] ?? null"
                  :saving="isSaving(line.key)"
                  :readonly="readonly"
                  @save="saveText(line.key, $event)"
                />
              </div>
            </li>
          </ol>
          <p class="text-muted text-xs">{{ t("agreementsRecord.selfNote") }}</p>
        </section>
      </template>
    </template>
  </div>
</template>
