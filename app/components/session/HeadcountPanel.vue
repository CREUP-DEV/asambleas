<script setup lang="ts">
import type { HeadcountDto } from "~~/shared/types/api";
import { quorumRequired, tallyHeadcount } from "~~/shared/utils/headcount";
import { HEADCOUNT_NOTE_MAX_LENGTH } from "~~/shared/utils/schemas/headcount";
import {
  delegateOptions,
  delegationsReceived,
  guestFormFrom,
  guestIdsOf,
  headcountEntriesOf,
  headcountFormFrom,
  headcountFormGuests,
  headcountFormMembers,
  setHeadcountDelegate,
  setHeadcountPresent,
  type FormGuest,
  type FormMember,
  type GuestForm,
  type HeadcountDraft,
  type HeadcountForm,
} from "~/composables/session/headcountForm";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Headcounts of the members with a vote (the active asociados): the Mesa
 * takes one at the start of each day, after a break or whenever it decides.
 * The latest one is the base of majorities on the members present, and it
 * says whether there is quorum under the threshold of the assembly type
 * (the call a session opens in). The sectorials and the guests (accounts
 * with the role Invitado) in the room are written down too, for the
 * record: they never vote, delegate nor count.
 *
 * The form is built for speed and follows the roll call (asociados,
 * sectorials, guests): a new count starts from the previous one, so the
 * Mesa only ticks who came and who left, one checkbox per member. A
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
const guestForm = ref<GuestForm>({});
const note = ref("");
const filter = ref("");
/** The form came back from a draft (the Mesa may start over). */
const restored = ref(false);
/** The form as it starts, without a draft: no draft is kept while equal. */
const baseline = ref<string | null>(null);

function snapshot(): string {
  return JSON.stringify({
    form: form.value,
    guests: guestForm.value,
    note: note.value,
  });
}

const formMembers = computed<FormMember[]>(() =>
  headcountFormMembers(dto.value?.members ?? [], editing.value),
);
/** The members with a vote, in the order of the form. */
const voterOrder = computed(() =>
  formMembers.value
    .filter((member) => member.voting)
    .map((member) => member.id),
);
const voters = computed(() => new Set(voterOrder.value));
const attendees = computed(
  () =>
    new Set(
      formMembers.value
        .filter((member) => !member.voting)
        .map((member) => member.id),
    ),
);
const byId = computed(
  () => new Map(formMembers.value.map((member) => [member.id, member])),
);
const formGuests = computed<FormGuest[]>(() =>
  headcountFormGuests(dto.value?.guests ?? [], editing.value),
);

function freshForm(target: HeadcountDto | null): void {
  const from = target ?? latest.value;
  form.value = headcountFormFrom(formMembers.value, from);
  guestForm.value = guestFormFrom(formGuests.value, from);
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
    // Only a member with a vote delegates, and only to another one.
    const base = headcountFormFrom(formMembers.value, null);
    for (const id of Object.keys(base)) {
      const row = saved.form[id];
      if (row) {
        base[id] = {
          present: row.present,
          delegateId:
            row.delegateId &&
            voters.value.has(id) &&
            voters.value.has(row.delegateId)
              ? row.delegateId
              : null,
        };
      }
    }
    form.value = base;
    // Guests no longer listed drop out; new ones start out of the room.
    guestForm.value = Object.fromEntries(
      formGuests.value.map((guest) => [
        guest.userId,
        saved.guests?.[guest.userId] ?? false,
      ]),
    );
    note.value = saved.note ?? "";
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
  [form, guestForm, note],
  () => {
    if (!open.value) return;
    if (snapshot() === baseline.value) {
      writeDraft(null);
      return;
    }
    writeDraft({
      targetId: editing.value?.id ?? null,
      form: form.value,
      guests: guestForm.value,
      note: note.value,
      savedAt: new Date().toISOString(),
    });
  },
  { deep: true },
);

const tally = computed(() =>
  tallyHeadcount(headcountEntriesOf(form.value), voters.value, attendees.value),
);
/** Sectorials and guests in the room: written down, never counted. */
const attending = computed(
  () => tally.value.attending + guestIdsOf(guestForm.value).length,
);
const received = computed(() => delegationsReceived(form.value));
const eligible = computed(() =>
  editing.value ? editing.value.eligible : voters.value.size,
);
/** A correction keeps its threshold; a new count, the type's. */
const required = computed(() => {
  if (editing.value) return editing.value.required;
  return rules.value ? quorumRequired(eligible.value, rules.value) : 0;
});
const quorumMet = computed(() => tally.value.present >= required.value);

type RollCallGroup = "asociado" | "sectorial";

/** The group a member is called in: with a vote, or without. */
function groupOf(member: FormMember): RollCallGroup {
  return member.voting ? "asociado" : "sectorial";
}

const query = computed(() =>
  filter.value.trim().toLocaleLowerCase(locale.value),
);

const shown = computed(() => {
  const matching = query.value
    ? formMembers.value.filter((member) =>
        [member.acronym, member.name, member.university ?? ""].some((value) =>
          value.toLocaleLowerCase(locale.value).includes(query.value),
        ),
      )
    : formMembers.value;
  const groups: { key: RollCallGroup; members: FormMember[] }[] = [];
  for (const member of matching) {
    const key = groupOf(member);
    const group = groups.find((item) => item.key === key);
    if (group) group.members.push(member);
    else groups.push({ key, members: [member] });
  }
  return groups;
});

const shownGuests = computed(() =>
  query.value
    ? formGuests.value.filter((guest) =>
        guest.name.toLocaleLowerCase(locale.value).includes(query.value),
      )
    : formGuests.value,
);

function toggleGuest(userId: string, value: boolean | "indeterminate") {
  guestForm.value = { ...guestForm.value, [userId]: value === true };
}

/** What a member is called: its denomination and, if any, its university. */
function denomination(member: FormMember): string | undefined {
  const name = member.name !== member.acronym ? member.name : "";
  const full = [name, member.university].filter(Boolean).join(" · ");
  return full || undefined;
}

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
    ...delegateOptions(form.value, memberId, voterOrder.value).map((id) => ({
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

/** Every asociado in the room; sectorials and guests are ticked one by one. */
function markAllPresent(): void {
  let next = form.value;
  for (const id of voterOrder.value) {
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
    entries: headcountEntriesOf(form.value),
    guests: guestIdsOf(guestForm.value),
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

          <p
            v-if="formMembers.length === 0 && formGuests.length === 0"
            class="text-muted text-sm"
          >
            {{ t("session.headcount.noMembers") }}
          </p>
          <div
            v-else
            class="border-default max-h-[45vh] overflow-y-auto rounded-lg border"
          >
            <section
              v-for="group in shown"
              :key="group.key"
              :aria-labelledby="'headcount-group-' + group.key"
            >
              <h3
                :id="'headcount-group-' + group.key"
                class="bg-elevated text-highlighted border-default sticky top-0 z-10 border-b px-3 py-1.5 text-xs font-semibold"
              >
                {{ t("session.headcount.groups." + group.key) }}
              </h3>
              <ul class="divide-default divide-y">
                <li
                  v-for="member in group.members"
                  :key="member.id"
                  class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
                >
                  <UCheckbox
                    :model-value="form[member.id]?.present ?? false"
                    :label="member.acronym"
                    :description="denomination(member)"
                    class="min-w-0 flex-1"
                    :ui="{ description: 'truncate' }"
                    @update:model-value="
                      (value) => togglePresent(member.id, value)
                    "
                  />
                  <USelectMenu
                    v-if="member.voting && !form[member.id]?.present"
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
            </section>
            <section
              v-if="shownGuests.length > 0"
              aria-labelledby="headcount-group-guest"
            >
              <h3
                id="headcount-group-guest"
                class="bg-elevated text-highlighted border-default sticky top-0 z-10 border-b px-3 py-1.5 text-xs font-semibold"
              >
                {{ t("session.headcount.groups.guest") }}
              </h3>
              <ul class="divide-default divide-y">
                <li
                  v-for="guest in shownGuests"
                  :key="guest.userId"
                  class="px-3 py-2"
                >
                  <UCheckbox
                    :model-value="guestForm[guest.userId] ?? false"
                    :label="guest.name"
                    @update:model-value="
                      (value) => toggleGuest(guest.userId, value)
                    "
                  />
                </li>
              </ul>
            </section>
          </div>

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
              <template v-if="attending > 0">
                ·
                {{
                  t(
                    "session.headcount.attending",
                    { count: attending },
                    attending,
                  )
                }}
              </template>
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
