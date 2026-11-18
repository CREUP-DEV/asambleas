<script setup lang="ts">
import type { MemberKind } from "~~/shared/constants/domain";
import type { MemberDto } from "~~/shared/types/api";
import { SPEAKER_NAME_MAX_LENGTH } from "~~/shared/utils/schemas/speakers";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Writes down who asks for the floor: a wide dialog with every member who
 * may ask as a grid of tiles (SessionMemberTile: avatar, acronym, a
 * council's university or any other member's name), grouped by kind, so
 * the Mesa finds them at a glance and clicks one; a search narrows the
 * grid, and Enter picks the only match. The person's name is optional, with
 * the names written before for that member to pick again; a turn may also
 * carry a name alone. Writing a turn down keeps the dialog open and clears
 * it, since several ask for the floor at once.
 *
 * Who is offered: the active members, councils and sectorials only while
 * in the room or delegated at the latest headcount (whoever holds the
 * delegation may speak for them; everyone before the first count), the
 * CEA's offices and the others always. Never the generic "CEA". Within each
 * kind those who spoke most in the assembly go first.
 */
const props = defineProps<{
  members: MemberDto[];
  loading: boolean;
}>();

const session = useSessionConsoleContext();
const speakers = session.speakers;
const { t, locale } = useI18n();

const open = computed({
  get: () => session.speakerAddDialog.open,
  set: (value: boolean) => {
    session.speakerAddDialog.open = value;
  },
});

const inRoom = computed<Set<string> | null>(() => {
  const latest = session.headcounts.latest.value;
  if (!latest) return null;
  return new Set(latest.entries.map((entry) => entry.member.id));
});

/** Whether the headcount says who of this kind is in the room. */
const COUNTED_KINDS = new Set<MemberKind>(["asociado", "sectorial"]);
/** The order of the groups: as every list of members (orderMembers). */
const KIND_ORDER: MemberKind[] = [
  "asociado",
  "sectorial",
  "other",
  "executive",
];

function spoken(memberId: string): number {
  return speakers.history.value.get(memberId)?.spoken ?? 0;
}

const offered = computed(() =>
  addableMembers(props.members).filter(
    (member) =>
      member.active &&
      (inRoom.value === null ||
        !COUNTED_KINDS.has(member.kind) ||
        inRoom.value.has(member.id)),
  ),
);

const filter = ref("");
const query = computed(() =>
  filter.value.trim().toLocaleLowerCase(locale.value),
);

const matching = computed(() =>
  query.value
    ? offered.value.filter((member) =>
        [member.acronym, member.name, member.university ?? ""].some((value) =>
          value.toLocaleLowerCase(locale.value).includes(query.value),
        ),
      )
    : offered.value,
);

const groups = computed(() =>
  KIND_ORDER.map((kind) => ({
    kind,
    members: matching.value
      .map((member, index) => ({ member, index }))
      .filter(({ member }) => member.kind === kind)
      .sort(
        (a, b) =>
          spoken(b.member.id) - spoken(a.member.id) || a.index - b.index,
      )
      .map(({ member }) => member),
  })).filter((group) => group.members.length > 0),
);

const memberId = ref<string | null>(null);
const speakerName = ref("");
const added = ref<string | null>(null);
const searchInput = useTemplateRef<{ inputRef?: HTMLInputElement | null }>(
  "searchInput",
);

const chosen = computed(() =>
  memberId.value
    ? (offered.value.find((member) => member.id === memberId.value) ?? null)
    : null,
);

/** The names already written down for the member chosen, latest first. */
const suggestions = computed(() =>
  memberId.value
    ? (speakers.history.value.get(memberId.value)?.speakers ?? [])
    : [],
);
const suggestionsId = useId();

watch(open, (isOpen) => {
  if (!isOpen) return;
  filter.value = "";
  memberId.value = null;
  speakerName.value = "";
  added.value = null;
});

function choose(id: string): void {
  memberId.value = memberId.value === id ? null : id;
}

/** Enter in the search picks the only member it leaves. */
function pickOnlyMatch(): void {
  if (matching.value.length === 1) memberId.value = matching.value[0]!.id;
}

function noteOf(member: MemberDto): string | null {
  const count = spoken(member.id);
  return count > 0 ? t("session.speakers.spokenCount", { count }, count) : null;
}

const adding = computed(() => Boolean(session.busy.value["speaker-add"]));
const canAdd = computed(
  () =>
    !adding.value &&
    session.inSession.value &&
    (Boolean(memberId.value) || speakerName.value.trim() !== ""),
);

async function addTurn(): Promise<void> {
  if (!canAdd.value || !session.requireInSession()) return;
  const who = chosen.value?.acronym ?? speakerName.value.trim();
  const ok = await speakers.add({
    memberId: memberId.value,
    speaker: speakerName.value.trim() || null,
  });
  if (!ok) return;
  added.value = who;
  memberId.value = null;
  speakerName.value = "";
  filter.value = "";
  await nextTick();
  searchInput.value?.inputRef?.focus();
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('session.speakers.addTitle')"
    :description="
      inRoom
        ? t('session.speakers.memberInRoom')
        : t('session.speakers.addHint')
    "
    :ui="{ content: 'sm:max-w-[min(96vw,100rem)] sm:h-[calc(100dvh-4rem)]' }"
  >
    <template #body>
      <form
        id="session-speaker-add"
        class="space-y-4"
        @submit.prevent="addTurn"
      >
        <UFormField
          :label="t('session.speakers.filter')"
          name="session-speaker-filter"
        >
          <UInput
            ref="searchInput"
            v-model="filter"
            icon="i-lucide-search"
            type="search"
            :placeholder="t('session.speakers.memberPlaceholder')"
            autofocus
            class="w-full"
            @keydown.enter.prevent="pickOnlyMatch"
          />
        </UFormField>

        <div v-if="loading" class="space-y-2" role="status">
          <span class="sr-only">{{ t("common.loading") }}</span>
          <USkeleton aria-hidden="true" class="h-16 w-full" />
        </div>
        <p v-else-if="groups.length === 0" class="text-muted text-sm">
          {{ t("session.speakers.noMatch") }}
        </p>
        <template v-else>
          <section
            v-for="group in groups"
            :key="group.kind"
            class="space-y-2"
            :aria-labelledby="'speaker-group-' + group.kind"
          >
            <h3
              :id="'speaker-group-' + group.kind"
              class="text-highlighted text-sm font-semibold"
            >
              {{ t("session.speakers.groups." + group.kind) }}
            </h3>
            <ul
              class="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-2"
            >
              <li v-for="member in group.members" :key="member.id">
                <SessionMemberTile
                  :member="member"
                  :selected="memberId === member.id"
                  :note="noteOf(member)"
                  class="h-full"
                  @toggle="choose(member.id)"
                />
              </li>
            </ul>
          </section>
        </template>
      </form>
    </template>
    <template #footer="{ close }">
      <div class="flex w-full flex-wrap items-end gap-2">
        <UFormField
          :label="
            chosen
              ? t('session.speakers.personFor', { member: chosen.acronym })
              : t('session.speakers.person')
          "
          :hint="t('session.vote.optional')"
          name="session-speaker-name"
          class="min-w-60 flex-1"
        >
          <UInput
            v-model="speakerName"
            :maxlength="SPEAKER_NAME_MAX_LENGTH"
            autocomplete="off"
            :list="suggestions.length > 0 ? suggestionsId : undefined"
            class="w-full"
            @keydown.enter.prevent="addTurn"
          />
          <!-- The names already written for this member, to pick again -->
          <datalist v-if="suggestions.length > 0" :id="suggestionsId">
            <option v-for="name in suggestions" :key="name" :value="name" />
          </datalist>
        </UFormField>
        <UButton
          type="submit"
          form="session-speaker-add"
          icon="i-lucide-plus"
          :label="t('session.speakers.add')"
          :loading="adding"
          :disabled="!canAdd"
        />
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('session.speakers.addDone')"
          @click="close"
        />
        <p class="text-muted w-full text-xs" role="status" aria-live="polite">
          {{ added ? t("session.speakers.added", { who: added }) : "" }}
        </p>
      </div>
    </template>
  </UModal>
</template>
