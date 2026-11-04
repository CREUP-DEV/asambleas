<script setup lang="ts">
import { z } from "zod/v4";
import type { FormSubmitEvent } from "@nuxt/ui";
import {
  DOCUMENT_FORMATS,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_DEFAULTS,
  MAJORITIES,
  type DocumentFormat,
  type DocumentKind,
  type Majority,
} from "~~/shared/constants/domain";
import type {
  DocumentCreateBody,
  DocumentDto,
  MemberDto,
} from "~~/shared/types/api";

/**
 * "Nuevo documento" (managers) and "Presentar documento" (members) under an
 * agenda item. Managers choose the proponent and may override the kind
 * defaults; members always present as their own member with the defaults.
 * On success it opens the document editor.
 */
const props = defineProps<{
  apiBase: string;
  /** Localized hub path ("/asambleas/80-ago"). */
  basePath: string;
  item: { id: string; title: string; number: string } | null;
  mode: "manager" | "member";
}>();

const open = defineModel<boolean>("open", { default: false });

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const { member } = useMe();

const TITLE_MAX = 300;
const SUMMARY_MAX = 5_000;
/** Sentinel for "no proponent" in the member select. */
const NO_PROPONENT = "__none__";

const isManager = computed(() => props.mode === "manager");

const schema = computed(() =>
  z.object({
    kind: z.enum(DOCUMENT_KINDS),
    format: z.enum(DOCUMENT_FORMATS),
    title: z
      .string()
      .trim()
      .min(1, t("agenda.newDocument.titleRequired"))
      .max(TITLE_MAX, t("agenda.form.tooLong", { max: TITLE_MAX })),
    summary: z
      .string()
      .max(SUMMARY_MAX, t("agenda.form.tooLong", { max: SUMMARY_MAX })),
    proponent: z.string(),
    amendable: z.boolean(),
    voted: z.boolean(),
    majority: z.enum(MAJORITIES),
  }),
);

type DocumentForm = z.output<typeof schema.value>;

function initialState(): DocumentForm {
  const kind: DocumentKind = "resolution";
  const defaults = DOCUMENT_KIND_DEFAULTS[kind];
  return {
    kind,
    format: "structured",
    title: "",
    summary: "",
    proponent: member.value?.id ?? NO_PROPONENT,
    amendable: defaults.amendable,
    voted: defaults.voted,
    majority: defaults.majority,
  };
}

const state = reactive<DocumentForm>(initialState());
const saving = ref(false);

// Members for the proponent select (managers only), loaded on first open.
const members = ref<MemberDto[]>([]);
const membersLoading = ref(false);
const membersFailed = ref(false);

async function loadMembers() {
  if (members.value.length > 0 || membersLoading.value) return;
  membersLoading.value = true;
  membersFailed.value = false;
  try {
    members.value = await api.get<MemberDto[]>("/api/members");
  } catch (error) {
    membersFailed.value = true;
    api.notifyError(error, "agenda.newDocument.membersError");
  } finally {
    membersLoading.value = false;
  }
}

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    Object.assign(state, initialState());
    if (isManager.value) void loadMembers();
  },
  { immediate: true },
);

// Kind defaults: a new kind resets amendable, voted and majority.
watch(
  () => state.kind,
  (kind) => {
    const defaults = DOCUMENT_KIND_DEFAULTS[kind];
    state.amendable = state.format === "file" ? false : defaults.amendable;
    state.voted = defaults.voted;
    state.majority = defaults.majority;
  },
);
watch(
  () => state.format,
  (format) => {
    state.amendable =
      format === "file" ? false : DOCUMENT_KIND_DEFAULTS[state.kind].amendable;
  },
);

const kindItems = computed(() =>
  DOCUMENT_KINDS.map((kind) => ({
    label: t(`agenda.documentKinds.${kind}`),
    value: kind,
  })),
);
const formatItems = computed(() =>
  DOCUMENT_FORMATS.map((format: DocumentFormat) => ({
    label: t(`agenda.formats.${format}`),
    description: t(`agenda.formatDescriptions.${format}`),
    value: format,
  })),
);
const majorityItems = computed(() =>
  MAJORITIES.map((majority: Majority) => ({
    label: t(`agenda.majorities.${majority}`),
    value: majority,
  })),
);
const memberItems = computed(() => [
  { label: t("agenda.newDocument.noProponent"), value: NO_PROPONENT },
  ...members.value
    .filter((candidate) => candidate.active || candidate.id === state.proponent)
    .map((candidate) => ({
      label: `${candidate.acronym} · ${candidate.name}`,
      value: candidate.id,
    })),
]);

const kindDefaults = computed(() => DOCUMENT_KIND_DEFAULTS[state.kind]);
const defaultsSummary = computed(() =>
  [
    kindDefaults.value.amendable && state.format !== "file"
      ? t("agenda.newDocument.amendableYes")
      : t("agenda.newDocument.amendableNo"),
    kindDefaults.value.voted
      ? t("agenda.newDocument.votedWith", {
          majority: t(`agenda.majorities.${kindDefaults.value.majority}`),
        })
      : t("agenda.newDocument.notVoted"),
  ].join(" · "),
);

async function onSubmit(event: FormSubmitEvent<DocumentForm>) {
  if (!props.item) return;
  const data = event.data;
  const body: DocumentCreateBody = {
    agendaItemId: props.item.id,
    kind: data.kind,
    format: data.format,
    title: data.title,
    summary: data.summary.trim() || null,
    ...(isManager.value
      ? {
          proponentMemberId:
            data.proponent === NO_PROPONENT ? null : data.proponent,
          amendable: data.format === "file" ? false : data.amendable,
          voted: data.voted,
          majority: data.majority,
        }
      : {}),
  };
  saving.value = true;
  try {
    const created = await api.send<DocumentDto>(`${props.apiBase}/documents`, {
      method: "POST",
      body,
    });
    toast.add({
      title: t("agenda.newDocument.created"),
      description: created.title,
      color: "success",
      icon: "i-lucide-file-plus",
    });
    open.value = false;
    await navigateTo(
      `${props.basePath}/documentos/${encodeURIComponent(created.slug)}/editar`,
    );
  } catch (error) {
    api.notifyError(error, "agenda.newDocument.error");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="
      isManager
        ? t('agenda.newDocument.title')
        : t('agenda.newDocument.submitTitle')
    "
    :description="
      item
        ? t('agenda.newDocument.under', {
            number: item.number,
            title: item.title,
          })
        : undefined
    "
    :dismissible="!saving"
    :ui="{ content: 'sm:max-w-2xl' }"
  >
    <template #body>
      <UForm
        id="agenda-new-document-form"
        :schema="schema"
        :state="state"
        class="space-y-4"
        @submit="onSubmit"
      >
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField
            :label="t('agenda.newDocument.kind')"
            name="kind"
            required
          >
            <USelect
              v-model="state.kind"
              :items="kindItems"
              value-key="value"
              class="w-full"
            />
          </UFormField>
          <UFormField
            v-if="isManager"
            :label="t('agenda.newDocument.proponent')"
            name="proponent"
            :help="
              membersFailed ? t('agenda.newDocument.membersError') : undefined
            "
          >
            <USelectMenu
              v-model="state.proponent"
              :items="memberItems"
              value-key="value"
              :loading="membersLoading"
              :search-input="{
                placeholder: t('agenda.newDocument.searchMember'),
              }"
              class="w-full"
            />
          </UFormField>
          <UFormField v-else :label="t('agenda.newDocument.proponent')">
            <div class="flex h-8 items-center">
              <CommonMemberBadge v-if="member" :member="member" show-name />
            </div>
          </UFormField>
        </div>

        <UFormField :label="t('agenda.newDocument.format')" name="format">
          <URadioGroup
            v-model="state.format"
            :items="formatItems"
            value-key="value"
            orientation="vertical"
            variant="card"
            class="w-full"
          />
        </UFormField>

        <UFormField
          :label="t('agenda.newDocument.documentTitle')"
          name="title"
          required
        >
          <UInput v-model="state.title" :maxlength="TITLE_MAX" class="w-full" />
        </UFormField>

        <UFormField
          :label="t('agenda.newDocument.summary')"
          :help="t('agenda.newDocument.summaryHelp')"
          name="summary"
        >
          <UTextarea
            v-model="state.summary"
            :rows="3"
            autoresize
            :maxrows="8"
            :maxlength="SUMMARY_MAX"
            class="w-full"
          />
        </UFormField>

        <fieldset
          v-if="isManager"
          class="border-default space-y-3 rounded-md border p-3"
        >
          <legend class="text-highlighted px-1 text-sm font-medium">
            {{ t("agenda.newDocument.rules") }}
          </legend>
          <p class="text-muted text-xs">
            {{ t("agenda.newDocument.rulesHelp") }}
          </p>
          <USwitch
            v-model="state.amendable"
            :disabled="state.format === 'file'"
            :label="t('agenda.newDocument.amendable')"
            :description="
              state.format === 'file'
                ? t('agenda.newDocument.fileNotAmendable')
                : undefined
            "
          />
          <USwitch
            v-model="state.voted"
            :label="t('agenda.newDocument.voted')"
          />
          <UFormField
            v-if="state.voted"
            :label="t('agenda.newDocument.majority')"
            name="majority"
          >
            <USelect
              v-model="state.majority"
              :items="majorityItems"
              value-key="value"
              class="w-full sm:w-64"
            />
          </UFormField>
        </fieldset>
        <p v-else class="text-muted text-sm">
          <UIcon
            name="i-lucide-info"
            class="me-1 inline size-4 align-[-2px]"
            aria-hidden="true"
          />{{ defaultsSummary }}
        </p>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          :label="t('common.cancel')"
          :disabled="saving"
          @click="open = false"
        />
        <UButton
          type="submit"
          form="agenda-new-document-form"
          icon="i-lucide-file-plus"
          :label="
            isManager
              ? t('agenda.newDocument.create')
              : t('agenda.newDocument.submit')
          "
          :loading="saving"
        />
      </div>
    </template>
  </UModal>
</template>
