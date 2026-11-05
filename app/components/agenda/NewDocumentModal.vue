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
import {
  kindSelectItems,
  presenterKindGroups,
} from "~/composables/document/documentKinds";

/**
 * Adds a document under an agenda item.
 *
 * - Members ("Presentar documento") go through the first step of a short
 *   guided flow: what it is (type, title, short summary) and, for types that
 *   take no amendments, whether the text comes as a PDF. The types their
 *   member usually presents come first (a CEA area's reports and plans, a
 *   council's positionings and resolutions), the rest under "Otros tipos". The draft is
 *   created and the editor opens on step 2 (the text) and step 3 (send it to
 *   the Secretaría).
 * - Managers also choose who presents it and the internal deadline, so the
 *   Secretaría can create in advance the documents it expects; the rules of
 *   the type (format, amendments, vote) stay under "Opciones avanzadas".
 *   A document expected from a member stays on the agenda; one with no
 *   presenter, or presented by the manager's own member, opens the editor.
 *
 * Emits `created` with the new document.
 */
const props = defineProps<{
  apiBase: string;
  /** Localized hub path ("/asambleas/80-ago"). */
  basePath: string;
  item: { id: string; title: string; number: string } | null;
  mode: "manager" | "member";
}>();

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{ created: [document: DocumentDto] }>();

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
    kind: z.enum(DOCUMENT_KINDS, {
      error: () => t("agenda.newDocument.kindRequired"),
    }),
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
    dueAt: z.string().nullable(),
    amendable: z.boolean(),
    voted: z.boolean(),
    majority: z.enum(MAJORITIES),
  }),
);

type DocumentForm = z.output<typeof schema.value>;
/** The kind starts empty: the user picks it. */
type DocumentFormState = Omit<DocumentForm, "kind"> & {
  kind: DocumentKind | undefined;
};

function initialState(): DocumentFormState {
  return {
    kind: undefined,
    format: "structured",
    title: "",
    summary: "",
    proponent: member.value?.id ?? NO_PROPONENT,
    dueAt: null,
    amendable: true,
    voted: true,
    majority: "simple",
  };
}

const state = reactive<DocumentFormState>(initialState());
const saving = ref(false);
const advancedOpen = ref(false);

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
    advancedOpen.value = false;
    if (isManager.value) void loadMembers();
  },
  { immediate: true },
);

/** The type's own rules: amendments, vote and majority. */
const kindDefaults = computed(() =>
  state.kind ? DOCUMENT_KIND_DEFAULTS[state.kind] : null,
);

/** A PDF can only be offered for types that take no amendments. */
const pdfAllowed = computed(
  () => isManager.value || kindDefaults.value?.amendable === false,
);

// A new kind resets the rules to its defaults (and a PDF it cannot take).
watch(
  () => state.kind,
  () => {
    const defaults = kindDefaults.value;
    if (!defaults) return;
    if (!pdfAllowed.value) state.format = "structured";
    state.amendable = state.format === "file" ? false : defaults.amendable;
    state.voted = defaults.voted;
    state.majority = defaults.majority;
  },
);
watch(
  () => state.format,
  (format) => {
    state.amendable =
      format === "file" ? false : (kindDefaults.value?.amendable ?? true);
  },
);

const kindItems = computed(() => {
  const label = (kind: DocumentKind) => t(`agenda.documentKinds.${kind}`);
  if (isManager.value) {
    return DOCUMENT_KINDS.map((kind) => ({ label: label(kind), value: kind }));
  }
  return kindSelectItems(
    presenterKindGroups({ memberKind: member.value?.kind }),
    label,
    {
      common: t("document.kindGroups.common"),
      others: t("document.kindGroups.others"),
    },
  );
});
const formatItems = computed(() =>
  DOCUMENT_FORMATS.map((format: DocumentFormat) => ({
    label: t(`agenda.formats.${format}`),
    description: t(`agenda.formatDescriptions.${format}`),
    value: format,
  })),
);
/** The presenter's choice, in their words. */
const sourceItems = computed(() =>
  DOCUMENT_FORMATS.map((format: DocumentFormat) => ({
    label: t(`agenda.newDocument.source.${format}`),
    description: t(`agenda.newDocument.source.${format}Description`),
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

/** The presenter's three steps; this modal is the first one. */
const steps = computed(() => [
  t("agenda.newDocument.steps.what"),
  t("agenda.newDocument.steps.text"),
  t("agenda.newDocument.steps.send"),
]);

const presenterMember = computed(() => {
  if (state.proponent === NO_PROPONENT) return null;
  return members.value.find((candidate) => candidate.id === state.proponent);
});

/** Managers stay on the agenda when someone else has to provide the text. */
function opensEditor(created: DocumentDto): boolean {
  if (!isManager.value) return true;
  const proponentId = created.proponent?.id ?? null;
  return proponentId === null || proponentId === member.value?.id;
}

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
          dueAt: data.dueAt,
        }
      : {}),
  };
  saving.value = true;
  try {
    const created = await api.send<DocumentDto>(`${props.apiBase}/documents`, {
      method: "POST",
      body,
    });
    emit("created", created);
    open.value = false;
    const editorPath = `${props.basePath}/documentos/${encodeURIComponent(created.slug)}/editar`;
    if (opensEditor(created)) {
      toast.add({
        title: isManager.value
          ? t("agenda.newDocument.created")
          : t("agenda.newDocument.draftCreated"),
        description: isManager.value
          ? created.title
          : t("agenda.newDocument.draftCreatedDescription"),
        color: "success",
        icon: "i-lucide-file-plus",
      });
      await navigateTo(editorPath);
      return;
    }
    toast.add({
      title: t("agenda.newDocument.created"),
      description: created.proponent
        ? t("agenda.newDocument.expectedFrom", {
            member: created.proponent.acronym,
          })
        : created.title,
      color: "success",
      icon: "i-lucide-file-plus",
      actions: [
        {
          label: t("agenda.newDocument.openDocument"),
          color: "neutral",
          variant: "outline",
          onClick: () => {
            void navigateTo(editorPath);
          },
        },
      ],
    });
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
      <!-- The presenter's guided flow: this is step 1 of 3 -->
      <ol
        v-if="!isManager"
        class="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
        :aria-label="t('agenda.newDocument.steps.label')"
      >
        <li
          v-for="(step, index) in steps"
          :key="step"
          class="flex items-center gap-2"
          :aria-current="index === 0 ? 'step' : undefined"
        >
          <span
            class="inline-flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums"
            :class="
              index === 0
                ? 'bg-primary text-inverted'
                : 'bg-elevated text-muted'
            "
            aria-hidden="true"
          >
            {{ index + 1 }}
          </span>
          <span
            :class="index === 0 ? 'text-highlighted font-medium' : 'text-muted'"
          >
            <span class="sr-only">
              {{
                t("agenda.newDocument.steps.position", {
                  step: index + 1,
                  total: steps.length,
                })
              }}
            </span>
            {{ step }}
          </span>
          <UIcon
            v-if="index < steps.length - 1"
            name="i-lucide-chevron-right"
            class="text-dimmed size-4"
            aria-hidden="true"
          />
        </li>
      </ol>

      <UForm
        id="agenda-new-document-form"
        :schema="schema"
        :state="state"
        class="space-y-4"
        @submit="onSubmit"
      >
        <UFormField :label="t('agenda.newDocument.kind')" name="kind" required>
          <USelect
            v-model="state.kind"
            :items="kindItems"
            :placeholder="t('agenda.newDocument.kindPlaceholder')"
            class="w-full sm:w-80"
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
            :rows="2"
            autoresize
            :maxrows="8"
            :maxlength="SUMMARY_MAX"
            class="w-full"
          />
        </UFormField>

        <!-- Members: how the text will come, only when a PDF is possible -->
        <template v-if="!isManager">
          <UFormField
            v-if="pdfAllowed"
            :label="t('agenda.newDocument.source.label')"
            name="format"
          >
            <URadioGroup
              v-model="state.format"
              :items="sourceItems"
              value-key="value"
              orientation="vertical"
              variant="card"
              class="w-full"
            />
          </UFormField>
          <p
            v-else-if="state.kind"
            class="text-muted flex items-start gap-2 text-sm"
          >
            <UIcon
              name="i-lucide-file-text"
              class="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {{ t("agenda.newDocument.source.wordHint") }}
          </p>

          <p v-if="member" class="text-muted flex items-center gap-2 text-sm">
            {{ t("agenda.newDocument.presentingAs") }}
            <CommonMemberBadge :member="member" show-name />
          </p>
        </template>

        <!-- Managers: who presents it and by when -->
        <div v-else class="grid gap-4 sm:grid-cols-2">
          <UFormField
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
          <UFormField
            :label="t('agenda.newDocument.dueAt')"
            :hint="t('agenda.newDocument.optional')"
            :help="
              presenterMember
                ? t('agenda.newDocument.dueAtHelpMember', {
                    member: presenterMember.acronym,
                  })
                : t('agenda.newDocument.dueAtHelp')
            "
            name="dueAt"
          >
            <DocumentDateTimeInput v-model="state.dueAt" name="dueAt" />
          </UFormField>
        </div>

        <UCollapsible v-if="isManager" v-model:open="advancedOpen">
          <UButton
            color="neutral"
            variant="link"
            size="sm"
            class="px-0"
            :icon="
              advancedOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
            "
            :label="t('agenda.newDocument.advanced')"
          />
          <template #content>
            <div class="border-default mt-2 space-y-4 rounded-md border p-3">
              <p class="text-muted text-xs">
                {{ t("agenda.newDocument.rulesHelp") }}
              </p>
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
            </div>
          </template>
        </UCollapsible>
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
          v-if="isManager"
          type="submit"
          form="agenda-new-document-form"
          icon="i-lucide-file-plus"
          :label="t('agenda.newDocument.create')"
          :loading="saving"
        />
        <UButton
          v-else
          type="submit"
          form="agenda-new-document-form"
          trailing-icon="i-lucide-arrow-right"
          :label="t('agenda.newDocument.continue')"
          :loading="saving"
        />
      </div>
    </template>
  </UModal>
</template>
