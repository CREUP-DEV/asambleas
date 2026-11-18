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
 * grid, and Enter picks the only match. Several may be picked at once, in
 * the order they asked (user's decision of 2026-11-18): each tile shows its
 * number, a second click takes it out and the others close up, and they
 * are written down one after another in that order. The person's name is
 * optional and goes with a single member, with the names written before
 * for that member to pick again; a turn may also carry a name alone.
 * Writing turns down keeps the dialog open and clears it, since several ask
 * for the floor at once.
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

/** The members picked, in the order they asked for the floor. */
const memberIds = ref<string[]>([]);
const speakerName = ref("");
/** Who was just written down, and how many. */
const added = ref<{ who: string; count: number } | null>(null);
/** While the turns go out one after another. */
const sending = ref(false);
const searchInput = useTemplateRef<{ inputRef?: HTMLInputElement | null }>(
  "searchInput",
);

const offeredById = computed(
  () => new Map(offered.value.map((member) => [member.id, member])),
);
/** The members picked that are still offered, in order. */
const chosen = computed(() =>
  memberIds.value
    .map((id) => offeredById.value.get(id))
    .filter((member): member is MemberDto => Boolean(member)),
);
/** A name goes with one member (or alone), never with several. */
const single = computed(() =>
  chosen.value.length === 1 ? chosen.value[0]! : null,
);
const several = computed(() => chosen.value.length > 1);

/** The names already written down for the member chosen, latest first. */
const suggestions = computed(() =>
  single.value
    ? (speakers.history.value.get(single.value.id)?.speakers ?? [])
    : [],
);
const suggestionsId = useId();

watch(open, (isOpen) => {
  if (!isOpen) return;
  filter.value = "";
  memberIds.value = [];
  speakerName.value = "";
  added.value = null;
});

/** Picks a member as the next to speak, or takes it out of the picks. */
function choose(id: string): void {
  memberIds.value = memberIds.value.includes(id)
    ? memberIds.value.filter((entry) => entry !== id)
    : [...memberIds.value, id];
}

/** Its place among the picks, from 1; null when not picked. */
function orderOf(id: string): number | null {
  const index = memberIds.value.indexOf(id);
  return index === -1 ? null : index + 1;
}

/** Enter in the search picks the only member it leaves. */
function pickOnlyMatch(): void {
  const only = matching.value.length === 1 ? matching.value[0]! : null;
  if (only && !memberIds.value.includes(only.id)) choose(only.id);
}

function noteOf(member: MemberDto): string | null {
  const count = spoken(member.id);
  return count > 0 ? t("session.speakers.spokenCount", { count }, count) : null;
}

const adding = computed(
  () => sending.value || Boolean(session.busy.value["speaker-add"]),
);
const canAdd = computed(
  () =>
    !adding.value &&
    session.inSession.value &&
    (chosen.value.length > 0 || speakerName.value.trim() !== ""),
);

/**
 * Writes the turns down one after another, in the order picked. One that
 * fails stops the rest: those already written leave the picks, the others
 * stay to try again.
 */
async function addTurn(): Promise<void> {
  if (!canAdd.value || !session.requireInSession()) return;
  const name = several.value ? null : speakerName.value.trim() || null;
  const queue: (MemberDto | null)[] =
    chosen.value.length > 0 ? [...chosen.value] : [null];
  const written: string[] = [];
  sending.value = true;
  try {
    for (const member of queue) {
      const ok = await speakers.add({
        memberId: member?.id ?? null,
        speaker: name,
      });
      if (!ok) break;
      written.push(member?.acronym ?? name ?? "");
      if (member) {
        memberIds.value = memberIds.value.filter((id) => id !== member.id);
      }
    }
  } finally {
    sending.value = false;
  }
  if (written.length === 0) return;
  added.value = { who: written.join(", "), count: written.length };
  if (memberIds.value.length > 0) return;
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
                  :selected="orderOf(member.id) !== null"
                  :order="orderOf(member.id)"
                  :order-label="
                    orderOf(member.id)
                      ? t('session.speakers.pickOrder', {
                          n: orderOf(member.id),
                        })
                      : null
                  "
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
        <!-- Several at once: no name, the order they go in instead. -->
        <p
          v-if="several"
          class="text-default min-w-60 flex-1 self-center text-sm"
        >
          {{
            t("session.speakers.pickedOrder", {
              who: chosen.map((member) => member.acronym).join(", "),
            })
          }}
        </p>
        <UFormField
          v-else
          :label="
            single
              ? t('session.speakers.personFor', { member: single.acronym })
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
          :label="
            several
              ? t('session.speakers.addMany', { count: chosen.length })
              : t('session.speakers.add')
          "
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
          {{
            !added
              ? ""
              : added.count > 1
                ? t("session.speakers.addedMany", { who: added.who })
                : t("session.speakers.added", { who: added.who })
          }}
        </p>
      </div>
    </template>
  </UModal>
</template>
