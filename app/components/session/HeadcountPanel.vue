<script setup lang="ts">
import type { HeadcountDto, MemberRef } from "~~/shared/types/api";
import {
  quorumRequired,
  quorumThreshold,
  tallyHeadcount,
  type QuorumCall,
} from "~~/shared/utils/headcount";
import { HEADCOUNT_NOTE_MAX_LENGTH } from "~~/shared/utils/schemas/headcount";
import {
  delegateOptions,
  delegationsReceived,
  headcountEntriesOf,
  headcountFormFrom,
  headcountFormMembers,
  setHeadcountDelegate,
  setHeadcountPresent,
  type HeadcountDraft,
  type HeadcountForm,
} from "~/composables/session/headcountForm";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Headcounts of the members with a vote (the active asociados): the Mesa
 * takes one at the start of each day, after a break or whenever it decides.
 * The latest one is the base of majorities on the members present, and it
 * says whether there is quorum under the rules of the assembly type.
 *
 * The form is built for speed: a new count starts from the previous one, so
 * the Mesa only ticks who came and who left, one checkbox per asociado. A
 * delegation, less frequent, is a quiet searchable menu on a member that is
 * not in the room; it counts only while its receiver is in the room, and
 * stays on the form otherwise. Until it is saved, the form is kept as a
 * draft on this device, so closing it by mistake (or reloading) loses
 * nothing.
 */
const session = useSessionConsoleContext();
const headcounts = session.headcounts;
const { t, locale } = useI18n();

const dto = computed(() => headcounts.data.value);
const latest = computed(() => headcounts.latest.value);
const earlier = computed(() => (dto.value?.headcounts ?? []).slice(1));
const rules = computed(() => dto.value?.quorum ?? null);
const writable = computed(() => {
  const status = session.assembly.value?.status;
  return status === "convened" || status === "in_session";
});

function when(headcount: HeadcountDto): string {
  return formatTime(headcount.takenAt, { locale: locale.value });
}

function figures(headcount: {
  present: number;
  eligible: number;
  delegated: number;
}): string {
  return t(
    "session.headcount.figures",
    {
      present: headcount.present,
      eligible: headcount.eligible,
      delegated: headcount.delegated,
    },
    headcount.delegated,
  );
}

// Draft (this device only) ---------------------------------------------------

const draftKey = computed(() =>
  session.assembly.value
    ? `session-headcount-draft-${session.assembly.value.id}`
    : null,
);
/** The draft on this device, read when the panel mounts and on each change. */
const draft = ref<HeadcountDraft | null>(null);

function readDraft(): HeadcountDraft | null {
  if (!import.meta.client || !draftKey.value) return null;
  try {
    const raw = localStorage.getItem(draftKey.value);
    return raw ? (JSON.parse(raw) as HeadcountDraft) : null;
  } catch {
    return null;
  }
}

function writeDraft(value: HeadcountDraft | null): void {
  draft.value = value;
  if (!import.meta.client || !draftKey.value) return;
  try {
    if (value) localStorage.setItem(draftKey.value, JSON.stringify(value));
    else localStorage.removeItem(draftKey.value);
  } catch {
    // Storage blocked: the draft lives only while the page stays open.
  }
}

onMounted(() => {
  draft.value = readDraft();
});
watch(draftKey, () => {
  draft.value = readDraft();
});

/** A draft of a new count, or of a correction of the latest one. */
const draftOfNew = computed(() => draft.value?.targetId === null);
const draftOfLatest = computed(
  () =>
    draft.value !== null &&
    draft.value.targetId !== null &&
    draft.value.targetId === latest.value?.id,
);

// The form ---------------------------------------------------------------------

const open = ref(false);
/** The count being corrected; null for a new one. */
const editing = ref<HeadcountDto | null>(null);
const form = ref<HeadcountForm>({});
const call = ref<QuorumCall>("first");
const note = ref("");
const filter = ref("");
/** The form came back from a draft (the Mesa may start over). */
const restored = ref(false);
/** The form as it starts, without a draft: no draft is kept while equal. */
const baseline = ref<string | null>(null);

function snapshot(): string {
  return JSON.stringify({
    form: form.value,
    call: call.value,
    note: note.value,
  });
}

const formMembers = computed<MemberRef[]>(() =>
  headcountFormMembers(dto.value?.members ?? [], editing.value),
);
const order = computed(() => formMembers.value.map((member) => member.id));
const byId = computed(
  () => new Map(formMembers.value.map((member) => [member.id, member])),
);

function freshForm(target: HeadcountDto | null): void {
  const from = target ?? latest.value;
  form.value = headcountFormFrom(formMembers.value, from);
  call.value = from?.call ?? "first";
  note.value = target?.note ?? "";
  restored.value = false;
  baseline.value = snapshot();
}

function start(target: HeadcountDto | null): void {
  editing.value = target;
  filter.value = "";
  freshForm(target);
  const saved = readDraft();
  if (saved && saved.targetId === (target?.id ?? null)) {
    // Members that left the roster drop out; new ones start out of the room.
    const base = headcountFormFrom(formMembers.value, null);
    for (const id of Object.keys(base)) {
      const row = saved.form[id];
      if (row) {
        base[id] = {
          present: row.present,
          delegateId:
            row.delegateId && base[row.delegateId] ? row.delegateId : null,
        };
      }
    }
    form.value = base;
    call.value = saved.call;
    note.value = saved.note;
    restored.value = true;
  }
  open.value = true;
}

function startOver(): void {
  writeDraft(null);
  freshForm(editing.value);
}

// Every change while the form is open is kept as the draft.
watch(
  [form, call, note],
  () => {
    if (!open.value) return;
    if (snapshot() === baseline.value) {
      writeDraft(null);
      return;
    }
    writeDraft({
      targetId: editing.value?.id ?? null,
      form: form.value,
      call: call.value,
      note: note.value,
      savedAt: new Date().toISOString(),
    });
  },
  { deep: true },
);

const callItems = computed(() =>
  rules.value?.secondCall
    ? (["first", "second"] as const).map((value) => ({
        label: t(`session.headcount.calls.${value}`),
        value,
      }))
    : [],
);

const tally = computed(() =>
  tallyHeadcount(headcountEntriesOf(form.value), new Set(order.value)),
);
const received = computed(() => delegationsReceived(form.value));
const eligible = computed(() =>
  editing.value ? editing.value.eligible : (dto.value?.members.length ?? 0),
);
const required = computed(() => {
  if (editing.value && editing.value.call === call.value) {
    return editing.value.required;
  }
  return rules.value
    ? quorumRequired(eligible.value, quorumThreshold(rules.value, call.value))
    : 0;
});
const quorumMet = computed(() => tally.value.present >= required.value);

const shown = computed(() => {
  const query = filter.value.trim().toLocaleLowerCase(locale.value);
  if (!query) return formMembers.value;
  return formMembers.value.filter(
    (member) =>
      member.acronym.toLocaleLowerCase(locale.value).includes(query) ||
      member.name.toLocaleLowerCase(locale.value).includes(query),
  );
});

function acronym(id: string | null | undefined): string {
  return (id && byId.value.get(id)?.acronym) || "";
}

function togglePresent(memberId: string, value: boolean | "indeterminate") {
  form.value = setHeadcountPresent(form.value, memberId, value === true);
}

/** The menu item that clears a delegation (reka-ui refuses an empty value). */
const NO_DELEGATION = "none";

/** Items of a member's delegation menu: none, then those it may delegate to. */
function delegateItems(memberId: string) {
  return [
    { label: t("session.headcount.noDelegation"), value: NO_DELEGATION },
    ...delegateOptions(form.value, memberId, order.value).map((id) => ({
      label: form.value[id]?.present
        ? acronym(id)
        : t("session.headcount.delegateOut", { member: acronym(id) }),
      value: id,
      name: byId.value.get(id)?.name ?? "",
    })),
  ];
}

function chooseDelegate(memberId: string, value: unknown): void {
  form.value = setHeadcountDelegate(
    form.value,
    memberId,
    typeof value === "string" && value !== NO_DELEGATION ? value : null,
  );
}

function markAllPresent(): void {
  let next = form.value;
  for (const id of order.value) {
    if (!next[id]?.present) next = setHeadcountPresent(next, id, true);
  }
  form.value = next;
}

const saving = computed(() =>
  Boolean(
    session.busy.value[
      editing.value ? `headcount-${editing.value.id}` : "headcount-add"
    ],
  ),
);
const canSave = computed(
  () => !saving.value && tally.value.problems.size === 0,
);

async function save(): Promise<void> {
  if (!canSave.value) return;
  const body = {
    call: rules.value?.secondCall ? call.value : ("first" as const),
    entries: headcountEntriesOf(form.value),
    note: note.value.trim() || null,
  };
  const ok = editing.value
    ? await headcounts.correct(editing.value, body)
    : await headcounts.add(body);
  if (ok) {
    open.value = false;
    writeDraft(null);
  }
}
</script>

<template>
  <div class="space-y-3">
    <p v-if="headcounts.loading.value" class="text-muted text-sm">
      {{ t("session.headcount.loading") }}
    </p>
    <UAlert
      v-else-if="headcounts.unavailable.value"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('session.headcount.errors.load')"
      :actions="[
        {
          label: t('session.headcount.retry'),
          color: 'neutral',
          variant: 'outline',
          onClick: () => void headcounts.refresh(),
        },
      ]"
    />
    <template v-else>
      <div v-if="latest" class="space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <UBadge
            :color="latest.quorum ? 'success' : 'error'"
            variant="subtle"
            :icon="
              latest.quorum ? 'i-lucide-circle-check' : 'i-lucide-circle-x'
            "
            :label="
              latest.quorum
                ? t('session.headcount.quorum')
                : t('session.headcount.noQuorum')
            "
          />
          <span class="text-highlighted text-sm font-medium tabular-nums">
            {{ figures(latest) }}
          </span>
        </div>
        <p class="text-muted text-xs tabular-nums">
          {{
            t("session.headcount.required", {
              required: latest.required,
              time: when(latest),
            })
          }}
          <template v-if="latest.note"> · {{ latest.note }}</template>
        </p>
      </div>
      <p v-else class="text-muted text-sm">
        {{ t("session.headcount.none") }}
      </p>

      <div v-if="writable" class="flex flex-wrap gap-2">
        <UButton
          :icon="draftOfNew ? 'i-lucide-file-pen-line' : 'i-lucide-users-round'"
          size="sm"
          :label="
            draftOfNew
              ? t('session.headcount.resume')
              : t('session.headcount.new')
          "
          @click="start(null)"
        />
        <UButton
          v-if="latest"
          icon="i-lucide-pencil"
          size="sm"
          color="neutral"
          variant="outline"
          :label="
            draftOfLatest
              ? t('session.headcount.resumeCorrection')
              : t('session.headcount.correct')
          "
          @click="start(latest)"
        />
      </div>

      <details v-if="earlier.length > 0" class="text-sm">
        <summary class="text-muted cursor-pointer">
          {{
            t(
              "session.headcount.earlier",
              { count: earlier.length },
              earlier.length,
            )
          }}
        </summary>
        <ul class="mt-2 space-y-1">
          <li
            v-for="headcount in earlier"
            :key="headcount.id"
            class="text-default tabular-nums"
          >
            {{ when(headcount) }} · {{ figures(headcount) }} ·
            {{
              headcount.quorum
                ? t("session.headcount.quorum")
                : t("session.headcount.noQuorum")
            }}
            <template v-if="headcount.note"> · {{ headcount.note }}</template>
          </li>
        </ul>
      </details>
    </template>

    <UModal
      v-model:open="open"
      :title="
        editing
          ? t('session.headcount.correctTitle', { time: when(editing) })
          : t('session.headcount.newTitle')
      "
      :description="t('session.headcount.description')"
      :ui="{ content: 'sm:max-w-2xl' }"
    >
      <template #body>
        <form
          id="session-headcount-form"
          class="space-y-4"
          @submit.prevent="save"
        >
          <UAlert
            v-if="restored"
            color="info"
            variant="subtle"
            icon="i-lucide-file-pen-line"
            :title="t('session.headcount.draftRestored')"
            :actions="[
              {
                label: t('session.headcount.startOver'),
                color: 'neutral',
                variant: 'outline',
                onClick: startOver,
              },
            ]"
          />

          <div class="grid gap-3 sm:grid-cols-2">
            <UFormField
              v-if="callItems.length > 0"
              :label="t('session.headcount.call')"
              name="headcount-call"
            >
              <USelect v-model="call" :items="callItems" class="w-full" />
            </UFormField>
            <UFormField
              :label="t('session.headcount.note')"
              :hint="t('session.vote.optional')"
              name="headcount-note"
            >
              <UInput
                v-model="note"
                :maxlength="HEADCOUNT_NOTE_MAX_LENGTH"
                :placeholder="t('session.headcount.notePlaceholder')"
                class="w-full"
              />
            </UFormField>
          </div>

          <div class="flex flex-wrap items-end gap-2">
            <UFormField
              :label="t('session.headcount.filter')"
              name="headcount-filter"
              class="min-w-0 flex-1"
            >
              <UInput
                v-model="filter"
                icon="i-lucide-search"
                type="search"
                class="w-full"
              />
            </UFormField>
            <UButton
              color="neutral"
              variant="outline"
              icon="i-lucide-check-check"
              :label="t('session.headcount.allPresent')"
              @click="markAllPresent"
            />
          </div>

          <p v-if="formMembers.length === 0" class="text-muted text-sm">
            {{ t("session.headcount.noMembers") }}
          </p>
          <ul
            v-else
            class="border-default divide-default max-h-[45vh] divide-y overflow-y-auto rounded-lg border"
            :aria-label="t('session.headcount.listLabel')"
          >
            <li
              v-for="member in shown"
              :key="member.id"
              class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
            >
              <UCheckbox
                :model-value="form[member.id]?.present ?? false"
                :label="member.acronym"
                :description="
                  member.name !== member.acronym ? member.name : undefined
                "
                class="min-w-0 flex-1"
                :ui="{ description: 'truncate' }"
                @update:model-value="(value) => togglePresent(member.id, value)"
              />
              <USelectMenu
                v-if="!form[member.id]?.present"
                :model-value="form[member.id]?.delegateId ?? undefined"
                :items="delegateItems(member.id)"
                value-key="value"
                :filter-fields="['label', 'name']"
                :search-input="
                  labelledSearch(t('session.headcount.searchDelegate'))
                "
                :placeholder="t('session.headcount.delegate')"
                :aria-label="
                  selectMenuLabel(
                    t('session.headcount.delegateOf', {
                      member: member.acronym,
                    }),
                    delegateItems(member.id),
                    form[member.id]?.delegateId || undefined,
                    t('session.headcount.noDelegation'),
                  )
                "
                :variant="form[member.id]?.delegateId ? 'outline' : 'ghost'"
                size="sm"
                icon="i-lucide-forward"
                class="w-40 shrink-0"
                @update:model-value="
                  (value) => chooseDelegate(member.id, value)
                "
              />
              <p
                v-if="
                  tally.problems.has(member.id) ||
                  tally.uncounted.has(member.id) ||
                  (form[member.id]?.present && received.has(member.id))
                "
                class="text-muted w-full text-xs"
              >
                <template v-if="tally.problems.has(member.id)">
                  <UIcon
                    name="i-lucide-circle-alert"
                    class="text-error size-3.5 align-middle"
                    aria-hidden="true"
                  />
                  {{
                    t(
                      `session.headcount.problems.${tally.problems.get(member.id)}`,
                    )
                  }}
                </template>
                <template v-else-if="tally.uncounted.has(member.id)">
                  <UIcon
                    name="i-lucide-triangle-alert"
                    class="text-warning size-3.5 align-middle"
                    aria-hidden="true"
                  />
                  {{
                    t("session.headcount.uncounted", {
                      member: acronym(form[member.id]?.delegateId),
                    })
                  }}
                </template>
                <template v-else>
                  {{
                    t("session.headcount.alsoVotesFor", {
                      member: acronym(received.get(member.id)),
                    })
                  }}
                </template>
              </p>
            </li>
          </ul>

          <div
            class="border-default bg-elevated/40 space-y-1 rounded-lg border p-3"
            aria-live="polite"
            aria-atomic="true"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-highlighted text-sm font-medium tabular-nums">
                {{
                  figures({
                    present: tally.present,
                    eligible,
                    delegated: tally.delegated,
                  })
                }}
              </span>
              <UBadge
                :color="quorumMet ? 'success' : 'error'"
                variant="subtle"
                :label="
                  quorumMet
                    ? t('session.headcount.quorum')
                    : t('session.headcount.noQuorum')
                "
              />
            </div>
            <p class="text-muted text-xs tabular-nums">
              {{ t("session.headcount.requiredOnly", { required }) }}
            </p>
            <p class="text-muted text-xs">
              {{ t("session.headcount.leadership") }}
            </p>
          </div>
        </form>
      </template>
      <template #footer="{ close }">
        <div class="flex w-full flex-wrap items-center justify-end gap-2">
          <p class="text-muted me-auto text-xs">
            {{ t("session.headcount.draftHint") }}
          </p>
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('session.headcount.later')"
            @click="close"
          />
          <UButton
            type="submit"
            form="session-headcount-form"
            icon="i-lucide-save"
            :label="t('session.headcount.save')"
            :loading="saving"
            :disabled="!canSave"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
