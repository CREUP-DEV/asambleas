<script setup lang="ts">
import type {
  MemberDto,
  SpeakerNoteBody,
  SpeakerNotesDto,
  SpeakingTurnDto,
} from "~~/shared/types/api";
import { orderMembers } from "~~/shared/utils/memberOrder";

/**
 * Who spoke on one agenda item or one amendment, and noting the rest (user's
 * decision of 2026-11-19), for the Mesa and whoever holds
 * session:record_speakers, in the live view and the control sheet's row
 * panel. Each member (or person by name) shows once, never how many times:
 * those given the floor from the session carry a microphone and stay; those
 * noted by hand can be taken back. Noting one already there changes nothing.
 *
 * The turns come from the caller (GET .../speakers/notes, or the sheet's
 * own); after a write the answer's turns go back through `updated`.
 */
const props = defineProps<{
  /** The item spoken on; for an amendment, null takes its own item. */
  agendaItemId: string | null;
  /** The amendment spoken on; null for the item itself. */
  amendmentId: string | null;
  /** Every turn of the assembly that spoke (SpeakingTurnDto.amendmentId). */
  turns: readonly SpeakingTurnDto[];
  /** Notes are refused once the assembly is closed or before it is convened. */
  writable: boolean;
}>();

const emit = defineEmits<{ updated: [turns: SpeakingTurnDto[]] }>();

const { t } = useI18n();
const api = useApi();
const { apiBase } = useCurrentAssembly();

interface SpokenEntry {
  key: string;
  label: string;
  /** The member's whole name, for screen readers and the tooltip. */
  title: string;
  names: string[];
  /** Given the floor from the session at least once: it stays. */
  fromQueue: boolean;
  /** Its notes by hand, which «Quitar» takes back. */
  notedIds: string[];
}

/** The turns of this item or amendment, each member or name once. */
const entries = computed<SpokenEntry[]>(() => {
  const byKey = new Map<string, SpokenEntry>();
  for (const turn of props.turns) {
    if (turn.status !== "speaking" && turn.status !== "done") continue;
    const onSubject = props.amendmentId
      ? turn.amendmentId === props.amendmentId
      : !turn.amendmentId && turn.agendaItemId === props.agendaItemId;
    if (!onSubject) continue;
    const name = turn.speaker?.trim() || null;
    const key = turn.member
      ? `m:${turn.member.id}`
      : name
        ? `n:${name.toLocaleLowerCase()}`
        : null;
    if (!key) continue;
    const entry = byKey.get(key) ?? {
      key,
      label: turn.member?.acronym ?? name!,
      title: turn.member?.name ?? name!,
      names: [],
      fromQueue: false,
      notedIds: [],
    };
    if (turn.noted) entry.notedIds.push(turn.id);
    else entry.fromQueue = true;
    if (turn.member && name && !entry.names.includes(name)) {
      entry.names.push(name);
    }
    byKey.set(key, entry);
  }
  return [...byKey.values()];
});

// Members to pick from: read once, when the editor first shows.
const members = ref<MemberDto[]>([]);
onMounted(async () => {
  try {
    members.value = await api.get<MemberDto[]>("/api/members");
  } catch {
    // The name field still works; the next time it opens reads them again.
  }
});
const memberItems = computed(() =>
  orderMembers(members.value.filter((member) => member.active)).map(
    memberMenuItem,
  ),
);

const memberId = ref<string | undefined>(undefined);
const speaker = ref("");
const busy = ref(false);

const canAdd = computed(
  () =>
    props.writable &&
    !busy.value &&
    (Boolean(memberId.value) || speaker.value.trim() !== ""),
);

async function add(): Promise<void> {
  if (!canAdd.value) return;
  busy.value = true;
  try {
    const body: SpeakerNoteBody = {
      agendaItemId: props.amendmentId ? null : props.agendaItemId,
      amendmentId: props.amendmentId,
      memberId: memberId.value ?? null,
      speaker: speaker.value.trim() || null,
    };
    const answer = await api.send<SpeakerNotesDto>(
      `${apiBase.value}/speakers/notes`,
      { method: "POST", body },
    );
    emit("updated", answer.turns);
    memberId.value = undefined;
    speaker.value = "";
  } catch (error) {
    api.notifyError(error, "speakerNotes.errors.add");
  } finally {
    busy.value = false;
  }
}

async function remove(entry: SpokenEntry): Promise<void> {
  if (!props.writable || busy.value) return;
  busy.value = true;
  try {
    let answer: SpeakerNotesDto | null = null;
    for (const id of entry.notedIds) {
      answer = await api.send<SpeakerNotesDto>(
        `${apiBase.value}/speakers/notes/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
    }
    if (answer) emit("updated", answer.turns);
  } catch (error) {
    api.notifyError(error, "speakerNotes.errors.remove");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="space-y-3">
    <p v-if="entries.length === 0" class="text-muted text-sm">
      {{ t("speakerNotes.none") }}
    </p>
    <ul
      v-else
      class="flex flex-wrap gap-1.5"
      :aria-label="t('speakerNotes.list')"
    >
      <li
        v-for="entry in entries"
        :key="entry.key"
        class="border-default bg-elevated/50 flex items-center gap-1 rounded-md border py-0.5 ps-2 pe-0.5 text-sm"
      >
        <UTooltip
          :text="
            [entry.title, ...entry.names].filter(Boolean).join(' · ') ||
            entry.label
          "
        >
          <span class="text-highlighted font-medium">{{ entry.label }}</span>
        </UTooltip>
        <span v-if="entry.names.length > 0" class="text-muted">
          {{ entry.names.join(", ") }}
        </span>
        <UTooltip v-if="entry.fromQueue" :text="t('speakerNotes.fromQueue')">
          <span class="flex items-center px-1">
            <UIcon
              name="i-lucide-mic"
              class="text-muted size-3.5"
              :aria-label="t('speakerNotes.fromQueue')"
            />
          </span>
        </UTooltip>
        <UButton
          v-else
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-x"
          :disabled="!writable || busy"
          :aria-label="t('speakerNotes.remove', { label: entry.label })"
          @click="remove(entry)"
        />
      </li>
    </ul>

    <form
      v-if="writable"
      class="flex flex-wrap items-end gap-2"
      @submit.prevent="add"
    >
      <UFormField :label="t('speakerNotes.member')" class="min-w-44 flex-1">
        <USelectMenu
          v-model="memberId"
          :items="memberItems"
          value-key="value"
          :ui="MEMBER_MENU_UI"
          :filter-fields="MEMBER_MENU_FILTER_FIELDS"
          :search-input="labelledSearch(t('speakerNotes.searchMember'))"
          :placeholder="t('speakerNotes.memberPlaceholder')"
          class="w-full"
        />
      </UFormField>
      <UFormField :label="t('speakerNotes.name')" class="min-w-40 flex-1">
        <UInput
          v-model="speaker"
          :maxlength="120"
          :placeholder="t('speakerNotes.namePlaceholder')"
          class="w-full"
        />
      </UFormField>
      <UButton
        type="submit"
        icon="i-lucide-plus"
        :loading="busy"
        :disabled="!canAdd"
        :label="t('speakerNotes.add')"
      />
    </form>
  </div>
</template>
