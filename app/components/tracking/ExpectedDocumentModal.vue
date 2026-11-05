<script setup lang="ts">
import { z } from "zod/v4";
import type { FormSubmitEvent } from "@nuxt/ui";
import {
  DOCUMENT_FORMATS,
  DOCUMENT_KINDS,
  MEMBER_KINDS,
  type DocumentFormat,
  type DocumentKind,
  type MemberKind,
} from "~~/shared/constants/domain";
import type {
  DocumentCreateBody,
  DocumentDto,
  MemberDto,
} from "~~/shared/types/api";

/**
 * "Añadir documento esperado": the Secretaría creates, in advance, an empty
 * document for the member that has to provide it (a CEA report, a
 * resolution), with an internal deadline. The member then finds it on their
 * home page and fills it in. Nothing opens afterwards: the panel shows it.
 *
 * The type's rules (amendments, vote) come from its defaults; only the
 * format is offered, folded away under "Más opciones".
 */
const props = defineProps<{
  /** "/api/assemblies/<id>" */
  apiBase: string;
  /** Agenda items in agenda order, with their number ("2.1"). */
  items: { id: string; number: string; title: string }[];
}>();

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ created: [document: DocumentDto] }>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const now = useAppNow();

const TITLE_MAX = 300;
const formId = useId();

const schema = computed(() =>
  z.object({
    agendaItemId: z.string().min(1, t("tracking.expected.itemRequired")),
    kind: z.enum(DOCUMENT_KINDS, {
      error: () => t("tracking.expected.kindRequired"),
    }),
    title: z
      .string()
      .trim()
      .min(1, t("tracking.expected.titleRequired"))
      .max(TITLE_MAX, t("agenda.form.tooLong", { max: TITLE_MAX })),
    proponentMemberId: z
      .string()
      .min(1, t("tracking.expected.presenterRequired")),
    dueAt: z.string().nullable(),
    format: z.enum(DOCUMENT_FORMATS),
  }),
);

type ExpectedForm = z.output<typeof schema.value>;
type ExpectedFormState = Omit<ExpectedForm, "kind"> & {
  kind: DocumentKind | undefined;
};

function initialState(): ExpectedFormState {
  return {
    agendaItemId: "",
    kind: undefined,
    title: "",
    proponentMemberId: "",
    dueAt: null,
    format: "structured",
  };
}

const state = reactive<ExpectedFormState>(initialState());

/** Lower bound of the picker: typed dates may still be earlier. */
const minDue = computed(() => new Date(now.value).toISOString());
const dueInPast = computed(
  () => state.dueAt !== null && new Date(state.dueAt).getTime() <= now.value,
);
const saving = ref(false);
const moreOpen = ref(false);

// Members, loaded on first open.
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
    api.notifyError(error, "tracking.expected.membersError");
  } finally {
    membersLoading.value = false;
  }
}

watch(
  open,
  (isOpen) => {
    if (!isOpen) return;
    Object.assign(state, initialState());
    moreOpen.value = false;
    void loadMembers();
  },
  { immediate: true },
);

const itemOptions = computed(() =>
  props.items.map((item) => ({
    label: item.number ? `${item.number}. ${item.title}` : item.title,
    value: item.id,
  })),
);

const kindOptions = computed(() =>
  DOCUMENT_KINDS.map((kind) => ({
    label: t(`agenda.documentKinds.${kind}`),
    value: kind,
  })),
);

/** Executive areas first: they provide most of the expected documents. */
const KIND_ORDER: readonly MemberKind[] = [
  "executive",
  ...MEMBER_KINDS.filter((kind) => kind !== "executive"),
];

interface MemberOption {
  label: string;
  value: string;
  type?: "label";
}

/** Grouped by kind; each group starts with its (unselectable) label. */
const memberOptions = computed<MemberOption[][]>(() =>
  KIND_ORDER.map((kind) => {
    const list: MemberOption[] = members.value
      .filter((candidate) => candidate.active && candidate.kind === kind)
      .map((candidate) => ({
        label: `${candidate.acronym} · ${candidate.name}`,
        value: candidate.id,
      }));
    if (list.length === 0) return [];
    const heading: MemberOption = {
      type: "label",
      label: t(`shell.memberKinds.${kind}`),
      value: `group:${kind}`,
    };
    return [heading, ...list];
  }).filter((group) => group.length > 0),
);

const formatOptions = computed(() =>
  DOCUMENT_FORMATS.map((format: DocumentFormat) => ({
    label: t(`agenda.formats.${format}`),
    description: t(`agenda.formatDescriptions.${format}`),
    value: format,
  })),
);

async function onSubmit(event: FormSubmitEvent<ExpectedForm>) {
  const data = event.data;
  const body: DocumentCreateBody = {
    agendaItemId: data.agendaItemId,
    kind: data.kind,
    format: data.format,
    title: data.title,
    proponentMemberId: data.proponentMemberId,
    dueAt: data.dueAt,
    // A PDF takes no amendments, whatever the type's default.
    ...(data.format === "file" ? { amendable: false } : {}),
  };
  saving.value = true;
  try {
    const created = await api.send<DocumentDto>(`${props.apiBase}/documents`, {
      method: "POST",
      body,
    });
    emit("created", created);
    open.value = false;
    toast.add({
      title: t("tracking.expected.created"),
      description: created.proponent
        ? t("tracking.expected.createdFor", {
            title: created.title,
            member: created.proponent.acronym,
          })
        : created.title,
      color: "success",
      icon: "i-lucide-file-plus",
    });
  } catch (error) {
    api.notifyError(error, "tracking.expected.error");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('tracking.expected.title')"
    :description="t('tracking.expected.description')"
    :dismissible="!saving"
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <UForm
        :id="formId"
        :schema="schema"
        :state="state"
        class="space-y-4"
        @submit="onSubmit"
      >
        <UFormField
          :label="t('tracking.expected.item')"
          name="agendaItemId"
          required
        >
          <USelect
            v-model="state.agendaItemId"
            :items="itemOptions"
            value-key="value"
            :placeholder="t('tracking.expected.itemPlaceholder')"
            class="w-full"
          />
        </UFormField>

        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField :label="t('tracking.expected.kind')" name="kind" required>
            <USelect
              v-model="state.kind"
              :items="kindOptions"
              value-key="value"
              :placeholder="t('tracking.expected.kindPlaceholder')"
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="t('tracking.expected.presenter')"
            :help="
              membersFailed ? t('tracking.expected.membersError') : undefined
            "
            name="proponentMemberId"
            required
          >
            <USelectMenu
              v-model="state.proponentMemberId"
              :items="memberOptions"
              value-key="value"
              :loading="membersLoading"
              :placeholder="t('tracking.expected.presenterPlaceholder')"
              :search-input="{
                placeholder: t('tracking.expected.searchMember'),
              }"
              :aria-label="t('tracking.expected.presenter')"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField
          :label="t('tracking.expected.documentTitle')"
          :help="t('tracking.expected.documentTitleHelp')"
          name="title"
          required
        >
          <UInput v-model="state.title" :maxlength="TITLE_MAX" class="w-full" />
        </UFormField>

        <UFormField
          :label="t('tracking.expected.deadline')"
          :help="t('tracking.expected.deadlineHelp')"
          name="dueAt"
        >
          <DocumentDateTimeInput
            v-model="state.dueAt"
            name="dueAt"
            :min="minDue"
          />
          <p
            v-if="dueInPast"
            class="text-warning mt-2 flex items-start gap-1.5 text-sm"
            role="status"
          >
            <UIcon
              name="i-lucide-triangle-alert"
              class="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <span>{{ t("tracking.deadline.pastWarning") }}</span>
          </p>
        </UFormField>

        <UCollapsible v-model:open="moreOpen" class="space-y-3">
          <UButton
            color="neutral"
            variant="link"
            class="px-0"
            :trailing-icon="
              moreOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
            "
            :label="t('tracking.expected.more')"
          />
          <template #content>
            <UFormField :label="t('tracking.expected.format')" name="format">
              <URadioGroup
                v-model="state.format"
                :items="formatOptions"
                value-key="value"
                orientation="vertical"
                variant="card"
                class="w-full"
              />
            </UFormField>
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
          type="submit"
          :form="formId"
          icon="i-lucide-file-plus"
          :label="t('tracking.expected.create')"
          :loading="saving"
        />
      </div>
    </template>
  </UModal>
</template>
