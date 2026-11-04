<script setup lang="ts">
import type { FormError, FormSubmitEvent } from "@nuxt/ui";
import {
  DOCUMENT_KIND_DEFAULTS,
  DOCUMENT_KINDS,
  MAJORITIES,
  type DocumentKind,
  type Majority,
} from "~~/shared/constants/domain";
import type {
  AgendaItemDto,
  AssemblyDto,
  DocumentDto,
  DocumentUpdateBody,
  MemberDto,
} from "~~/shared/types/api";
import { formatDateTime, toDate } from "~/utils/format";

/**
 * Metadata of a document: title, summary, kind, agenda item, proponent,
 * amendable / voted / majority and the amendment window override. Sends only
 * the fields that changed, with `updatedAt`.
 *
 * Presenters may change title, summary, kind and agenda item of their draft;
 * the server gives them the defaults of the kind. Everything else needs
 * document:manage (`document.can.manage`) and is read-only otherwise.
 * Managers keep this form after publication, when the text is frozen.
 *
 * Emits `saved` with the updated DocumentDto (store it), and `stale` after an
 * optimistic-lock conflict (refetch the document; the form then reloads).
 */
const props = defineProps<{
  document: DocumentDto;
  assembly: AssemblyDto;
}>();

const emit = defineEmits<{
  saved: [document: DocumentDto];
  stale: [];
}>();

/** True while the form holds unsaved changes. */
const dirty = defineModel<boolean>("dirty", { default: false });

const { t, locale } = useI18n();
const toast = useToast();
const { send, notifyError, isConflict } = useApi();

const TITLE_MAX = 300;
const SUMMARY_MAX = 5_000;

const manager = computed(() => props.document.can.manage);
const isFile = computed(() => props.document.format === "file");

interface FormState {
  title: string;
  summary: string;
  kind: DocumentKind;
  agendaItemId: string;
  proponentMemberId: string | null;
  amendable: boolean;
  voted: boolean;
  majority: Majority;
  windowOverride: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

function milestoneAt(key: "amendments_open" | "amendments_close") {
  return props.assembly.milestones.find((m) => m.key === key)?.at ?? null;
}

function sameInstant(a: string | null, b: string | null): boolean {
  const left = toDate(a);
  const right = toDate(b);
  if (!left || !right) return !left && !right;
  return left.getTime() === right.getTime();
}

const calendarOpensAt = computed(() => milestoneAt("amendments_open"));
const calendarClosesAt = computed(() => milestoneAt("amendments_close"));

/** Form state from the stored document (the override as stored, null = calendar). */
function snapshot(document: DocumentDto): FormState {
  const opensAt = document.amendmentsOpenAt;
  const closesAt = document.amendmentsCloseAt;
  return {
    title: document.title,
    summary: document.summary ?? "",
    kind: document.kind,
    agendaItemId: document.agendaItemId,
    proponentMemberId: document.proponent?.id ?? null,
    amendable: document.amendable,
    voted: document.voted,
    majority: document.majority,
    windowOverride: opensAt !== null || closesAt !== null,
    opensAt,
    closesAt,
  };
}

const initial = shallowRef<FormState>(snapshot(props.document));
const state = reactive<FormState>({ ...initial.value });
const saving = ref(false);
const conflictNotice = ref(false);
let resyncNext = false;

function resetForm(): void {
  initial.value = snapshot(props.document);
  Object.assign(state, initial.value);
}

/** The window values that would be stored (null = follow the calendar). */
const desiredWindow = computed(() => ({
  opensAt: state.windowOverride ? state.opensAt : null,
  closesAt: state.windowOverride ? state.closesAt : null,
}));

function buildBody(): DocumentUpdateBody {
  const before = initial.value;
  const body: DocumentUpdateBody = { updatedAt: props.document.updatedAt };
  const title = state.title.trim();
  if (title !== before.title) body.title = title;
  const summary = state.summary.trim();
  if (summary !== before.summary.trim()) body.summary = summary || null;
  if (state.kind !== before.kind) body.kind = state.kind;
  if (state.agendaItemId !== before.agendaItemId)
    body.agendaItemId = state.agendaItemId;
  if (!manager.value) return body;

  if (state.proponentMemberId !== before.proponentMemberId)
    body.proponentMemberId = state.proponentMemberId;
  const amendable = isFile.value ? false : state.amendable;
  if (amendable !== before.amendable) body.amendable = amendable;
  if (state.voted !== before.voted) body.voted = state.voted;
  if (state.majority !== before.majority) body.majority = state.majority;
  if (!sameInstant(desiredWindow.value.opensAt, before.opensAt))
    body.amendmentsOpenAt = desiredWindow.value.opensAt;
  if (!sameInstant(desiredWindow.value.closesAt, before.closesAt))
    body.amendmentsCloseAt = desiredWindow.value.closesAt;
  return body;
}

const changedCount = computed(
  () => Object.keys(buildBody()).filter((key) => key !== "updatedAt").length,
);

watch(
  changedCount,
  (count) => {
    dirty.value = count > 0;
    if (count > 0) conflictNotice.value = false;
  },
  { immediate: true },
);

// Reload from the server copy when it changes, unless the user is editing.
watch(
  () => props.document.updatedAt,
  () => {
    if (resyncNext || !dirty.value) {
      resyncNext = false;
      resetForm();
    }
  },
);

// Kind defaults ---------------------------------------------------------------

const kindDefaults = computed(() => DOCUMENT_KIND_DEFAULTS[state.kind]);
const kindChanged = computed(() => state.kind !== initial.value.kind);

/** What presenters will get: the server applies the kind defaults. */
const effective = computed(() => {
  if (manager.value || !kindChanged.value) {
    return {
      amendable: isFile.value ? false : state.amendable,
      voted: state.voted,
      majority: state.majority,
    };
  }
  return {
    amendable: isFile.value ? false : kindDefaults.value.amendable,
    voted: kindDefaults.value.voted,
    majority: kindDefaults.value.majority,
  };
});

const differsFromDefaults = computed(
  () =>
    manager.value &&
    ((!isFile.value && state.amendable !== kindDefaults.value.amendable) ||
      state.voted !== kindDefaults.value.voted ||
      state.majority !== kindDefaults.value.majority),
);

function applyKindDefaults(): void {
  if (!isFile.value) state.amendable = kindDefaults.value.amendable;
  state.voted = kindDefaults.value.voted;
  state.majority = kindDefaults.value.majority;
}

// Options -----------------------------------------------------------------

const kindItems = computed(() =>
  DOCUMENT_KINDS.map((kind) => ({
    label: t(`document.kinds.${kind}`),
    value: kind,
  })),
);

const majorityItems = computed(() =>
  MAJORITIES.map((majority) => ({
    label: t(`document.majorities.${majority}`),
    value: majority,
  })),
);

// Shared with the hub's agenda pages (same key, refreshed on live events).
const { data: agenda, status: agendaStatus } = useAssemblyAgenda();

const agendaItems = computed(() => {
  const items = agenda.value?.items ?? [];
  const children = new Map<string | null, AgendaItemDto[]>();
  for (const item of items) {
    const list = children.get(item.parentId) ?? [];
    list.push(item);
    children.set(item.parentId, list);
  }
  const result: { label: string; value: string; disabled: boolean }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const list = (children.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.order - b.order);
    for (const item of list) {
      result.push({
        label: `${"\u2003".repeat(depth)}${item.title}`,
        value: item.id,
        disabled:
          !manager.value &&
          !item.acceptsSubmissions &&
          item.id !== initial.value.agendaItemId,
      });
      visit(item.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
});

const currentAgendaTitle = computed(
  () =>
    agenda.value?.items.find((item) => item.id === state.agendaItemId)?.title ??
    null,
);

const { data: members, status: membersStatus } = useFetch<MemberDto[]>(
  "/api/members",
  {
    key: "members:active",
    lazy: true,
    default: () => [],
    immediate: manager.value,
  },
);

const memberItems = computed(() => {
  const list = (members.value ?? []).map((member) => ({
    label: member.acronym,
    description: member.name,
    value: member.id,
  }));
  const current = props.document.proponent;
  if (current && !list.some((item) => item.value === current.id)) {
    list.unshift({
      label: current.acronym,
      description: current.name,
      value: current.id,
    });
  }
  return list;
});

// Window hints ------------------------------------------------------------

function calendarHint(value: string | null): string {
  return value
    ? t("document.metadata.calendarValue", {
        date: formatDateTime(value, { locale: locale.value }),
      })
    : t("document.metadata.calendarNone");
}

function onOverrideToggle(enabled: boolean): void {
  if (enabled) {
    state.opensAt ??= props.document.window.opensAt ?? calendarOpensAt.value;
    state.closesAt ??= props.document.window.closesAt ?? calendarClosesAt.value;
  }
}

const showWindow = computed(
  () => manager.value && !isFile.value && state.amendable,
);

// Validation and submit -----------------------------------------------------

function validate(current: Partial<FormState>): FormError[] {
  const errors: FormError[] = [];
  const title = (current.title ?? "").trim();
  if (!title)
    errors.push({
      name: "title",
      message: t("document.metadata.errors.titleRequired"),
    });
  else if (title.length > TITLE_MAX)
    errors.push({
      name: "title",
      message: t("document.metadata.errors.titleTooLong", { max: TITLE_MAX }),
    });
  if ((current.summary ?? "").trim().length > SUMMARY_MAX)
    errors.push({
      name: "summary",
      message: t("document.metadata.errors.summaryTooLong", {
        max: SUMMARY_MAX,
      }),
    });
  if (current.windowOverride && showWindow.value) {
    const opens = toDate(current.opensAt ?? null);
    const closes = toDate(current.closesAt ?? null);
    if (opens && closes && closes <= opens)
      errors.push({
        name: "closesAt",
        message: t("document.metadata.errors.closeBeforeOpen"),
      });
  }
  return errors;
}

async function onSubmit(_event: FormSubmitEvent<FormState>): Promise<void> {
  if (saving.value || changedCount.value === 0) return;
  saving.value = true;
  try {
    const updated = await send<DocumentDto>(
      `/api/assemblies/${encodeURIComponent(props.assembly.id)}/documents/${encodeURIComponent(props.document.id)}`,
      { method: "PUT", body: buildBody() },
    );
    resyncNext = true;
    emit("saved", updated);
    toast.add({
      title: t("document.metadata.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    notifyError(error, "document.metadata.saveError");
    if (isConflict(error)) {
      conflictNotice.value = true;
      resyncNext = true;
      emit("stale");
    }
  } finally {
    saving.value = false;
  }
}

defineExpose({ reset: resetForm });
</script>

<template>
  <UForm
    :state="state"
    :validate="validate"
    :validate-on="['blur', 'change']"
    class="space-y-4"
    @submit="onSubmit"
  >
    <UAlert
      v-if="conflictNotice"
      color="warning"
      variant="subtle"
      icon="i-lucide-refresh-ccw"
      :title="t('document.metadata.conflictTitle')"
      :description="t('document.metadata.conflictDescription')"
      role="alert"
    />

    <UFormField name="title" :label="t('document.metadata.title')" required>
      <UInput
        v-model="state.title"
        :maxlength="TITLE_MAX"
        class="w-full"
        autocomplete="off"
      />
    </UFormField>

    <UFormField
      name="summary"
      :label="t('document.metadata.summary')"
      :hint="t('document.metadata.optional')"
      :description="t('document.metadata.summaryDescription')"
    >
      <UTextarea
        v-model="state.summary"
        :maxlength="SUMMARY_MAX"
        :rows="3"
        autoresize
        :maxrows="10"
        class="w-full"
      />
    </UFormField>

    <UFormField name="kind" :label="t('document.metadata.kind')" required>
      <USelect v-model="state.kind" :items="kindItems" class="w-full" />
    </UFormField>

    <UFormField name="format" :label="t('document.metadata.format')">
      <p class="text-default flex items-center gap-2 text-sm">
        <UIcon
          :name="isFile ? 'i-lucide-file-text' : 'i-lucide-text'"
          class="text-muted size-4"
          aria-hidden="true"
        />
        {{ t(`document.formats.${document.format}`) }}
      </p>
    </UFormField>

    <UFormField name="agendaItemId" :label="t('document.metadata.agendaItem')">
      <USkeleton
        v-if="agendaStatus === 'pending' && !agenda"
        class="h-8 w-full"
      />
      <USelect
        v-else-if="agendaItems.length > 0"
        v-model="state.agendaItemId"
        :items="agendaItems"
        class="w-full"
      />
      <p v-else class="text-muted text-sm">
        {{ currentAgendaTitle ?? t("document.metadata.agendaUnavailable") }}
      </p>
    </UFormField>

    <UFormField
      name="proponentMemberId"
      :label="t('document.metadata.proponent')"
      :description="manager ? undefined : t('document.metadata.managerOnly')"
    >
      <USelectMenu
        v-if="manager"
        v-model="state.proponentMemberId"
        :items="memberItems"
        value-key="value"
        :filter-fields="['label', 'description']"
        :loading="membersStatus === 'pending'"
        :placeholder="t('document.metadata.proponentPlaceholder')"
        :search-input="{ placeholder: t('document.metadata.searchMember') }"
        clear
        class="w-full"
      />
      <CommonMemberBadge
        v-else-if="document.proponent"
        :member="document.proponent"
        show-name
      />
      <p v-else class="text-muted text-sm">
        {{ t("document.metadata.noProponent") }}
      </p>
    </UFormField>

    <USeparator />

    <div class="space-y-3">
      <div class="flex items-center justify-between gap-2">
        <h4 class="text-highlighted text-sm font-semibold">
          {{ t("document.metadata.procedure") }}
        </h4>
        <UButton
          v-if="differsFromDefaults"
          size="xs"
          color="neutral"
          variant="link"
          icon="i-lucide-rotate-ccw"
          :label="t('document.metadata.applyDefaults')"
          @click="applyKindDefaults"
        />
      </div>

      <p v-if="!manager" class="text-muted text-xs">
        {{ t("document.metadata.kindDefaultsHint") }}
      </p>

      <UFormField
        name="amendable"
        :description="
          isFile ? t('document.metadata.fileNotAmendable') : undefined
        "
      >
        <USwitch
          v-if="manager"
          v-model="state.amendable"
          :disabled="isFile"
          :label="t('document.metadata.amendable')"
        />
        <USwitch
          v-else
          :model-value="effective.amendable"
          disabled
          :label="t('document.metadata.amendable')"
        />
      </UFormField>

      <UFormField name="voted">
        <USwitch
          v-if="manager"
          v-model="state.voted"
          :label="t('document.metadata.voted')"
        />
        <USwitch
          v-else
          :model-value="effective.voted"
          disabled
          :label="t('document.metadata.voted')"
        />
      </UFormField>

      <UFormField
        v-if="effective.voted"
        name="majority"
        :label="t('document.metadata.majority')"
      >
        <USelect
          v-if="manager"
          v-model="state.majority"
          :items="majorityItems"
          class="w-full"
        />
        <p v-else class="text-default text-sm">
          {{ t(`document.majorities.${effective.majority}`) }}
        </p>
      </UFormField>
    </div>

    <template v-if="showWindow">
      <USeparator />
      <div class="space-y-3">
        <UFormField
          name="windowOverride"
          :description="t('document.metadata.windowOverrideDescription')"
        >
          <USwitch
            v-model="state.windowOverride"
            :label="t('document.metadata.windowOverride')"
            @update:model-value="onOverrideToggle"
          />
        </UFormField>

        <template v-if="state.windowOverride">
          <UFormField
            name="opensAt"
            :label="t('document.metadata.opensAt')"
            :description="calendarHint(calendarOpensAt)"
            :hint="t('document.metadata.timeZone')"
          >
            <DocumentDateTimeInput v-model="state.opensAt" />
          </UFormField>
          <UFormField
            name="closesAt"
            :label="t('document.metadata.closesAt')"
            :description="calendarHint(calendarClosesAt)"
            :hint="t('document.metadata.timeZone')"
          >
            <DocumentDateTimeInput
              v-model="state.closesAt"
              :min="state.opensAt"
            />
          </UFormField>
        </template>
      </div>
    </template>

    <div class="flex flex-wrap items-center justify-end gap-2 pt-1">
      <UButton
        v-if="dirty"
        color="neutral"
        variant="ghost"
        :label="t('document.metadata.reset')"
        :disabled="saving"
        @click="resetForm"
      />
      <UButton
        type="submit"
        icon="i-lucide-save"
        :label="t('document.metadata.save')"
        :loading="saving"
        :disabled="!dirty"
      />
    </div>
  </UForm>
</template>
