<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import type { MemberDto, SpeakingTurnDto } from "~~/shared/types/api";
import { SPEAKER_NAME_MAX_LENGTH } from "~~/shared/utils/schemas/speakers";
import {
  sessionFormatDuration,
  sessionTurnDuration,
  sessionTurnWho,
} from "~/composables/session/sessionModel";
import {
  SPEAKERS_VISIBLE_BUSY_KEY,
  useSessionConsoleContext,
} from "~/composables/session/useSessionConsole";

/**
 * Speaking turns: the Mesa writes down who asks for the floor (a member,
 * found by acronym or name, and optionally the person), gives the floor,
 * ends it and keeps the queue in order. Every Mesa device sees the same
 * list, live. Who has the floor and the one next step lead; a switch at the
 * bottom (a setting that rarely changes) decides whether the attendees see
 * who has the floor and who is next, in the live view and on the
 * projection.
 *
 * The waiting list stays clean: each row has one "Más" menu, and reordering
 * happens in an explicit mode with up and down buttons that keep the
 * keyboard focus on the turn being moved. Mistakes are mended from "Más":
 * the floor given to the wrong person goes back to the head of the list,
 * and a misspelt name is corrected.
 */
const session = useSessionConsoleContext();
const speakers = session.speakers;
const { t } = useI18n();
const toast = useToast();

const view = computed(() => speakers.view.value);
const speaking = computed(() => view.value.speaking);
const waiting = computed(() => view.value.waiting);
const done = computed(() => view.value.done);
const firstWaiting = computed(() => waiting.value[0] ?? null);

function who(turn: SpeakingTurnDto): string {
  return sessionTurnWho(turn) ?? t("session.speakers.unnamed");
}

function busyFor(turn: SpeakingTurnDto): boolean {
  return Boolean(session.busy.value[`speaker-${turn.id}`]);
}
/** A turn is changing: the floor buttons wait (adding one does not block). */
const anyTurnBusy = computed(() =>
  Object.keys(session.busy.value).some(
    (key) => key.startsWith("speaker-") && key !== "speaker-add",
  ),
);

// Who sees the turns ---------------------------------------------------------

const visible = computed(
  () => session.liveState.value?.speakersVisible ?? false,
);
// Its own busy key: the debate buttons do not wait for it.
const visibleBusy = computed(() =>
  Boolean(session.busy.value[SPEAKERS_VISIBLE_BUSY_KEY]),
);

function setVisible(value: boolean): void {
  if (visibleBusy.value || value === visible.value) return;
  void session.setSpeakersVisible(value);
}

// Adding a turn --------------------------------------------------------------

const { data: members, status: membersStatus } = useLazyFetch<MemberDto[]>(
  "/api/members",
  {
    key: "session-speaker-members",
    // Guests attend and may be given the floor, though they never vote.
    query: { guests: 1 },
    server: false,
    default: () => [],
  },
);

/** Never the generic "CEA": it is not a member the Mesa gives the floor to. */
const memberItems = computed(() =>
  addableMembers(members.value ?? [])
    .filter((member) => member.active)
    .map((member) => ({
      label: memberLabel(member),
      value: member.id,
    })),
);

const memberId = ref<string | undefined>(undefined);
const speakerName = ref("");
const memberInput = useTemplateRef<{ inputRef?: HTMLInputElement | null }>(
  "memberInput",
);
const adding = computed(() => Boolean(session.busy.value["speaker-add"]));
const canAdd = computed(
  () =>
    !adding.value &&
    (Boolean(memberId.value) || speakerName.value.trim() !== ""),
);

/** Writes the turn down, clears the form and goes back to the search. */
async function addTurn(): Promise<void> {
  if (!canAdd.value) return;
  const ok = await speakers.add({
    memberId: memberId.value ?? null,
    speaker: speakerName.value.trim() || null,
  });
  if (!ok) return;
  memberId.value = undefined;
  speakerName.value = "";
  await nextTick();
  memberInput.value?.inputRef?.focus();
}

// The floor ------------------------------------------------------------------

/**
 * The one main action: give the floor to the first in line (which ends the
 * current turn), or end the current turn when nobody is waiting.
 */
const mainAction = computed(() => {
  const first = firstWaiting.value;
  if (first) {
    return {
      label: speaking.value
        ? t("session.speakers.nextTo", { who: who(first) })
        : t("session.speakers.giveTo", { who: who(first) }),
      icon: "i-lucide-mic",
      busy:
        busyFor(first) || (speaking.value ? busyFor(speaking.value) : false),
    };
  }
  if (speaking.value) {
    return {
      label: t("session.speakers.finish"),
      icon: "i-lucide-mic-off",
      busy: busyFor(speaking.value),
    };
  }
  return null;
});

const renameItem = (turn: SpeakingTurnDto): DropdownMenuItem => ({
  label: t("session.speakers.rename"),
  icon: "i-lucide-pencil",
  onSelect: () => session.openSpeakerRename(turn),
});

/**
 * Gives the floor out of turn. It ends the turn of whoever was speaking, so
 * the Mesa is told: the menu item does not say it, unlike "Siguiente".
 */
async function giveFloorNow(turn: SpeakingTurnDto): Promise<void> {
  const current = speaking.value;
  const ok = await speakers.giveFloor(turn);
  if (ok && current && current.id !== turn.id) {
    toast.add({
      id: `session-speaker-ended-${current.id}`,
      title: t("session.speakers.interrupted", { who: who(current) }),
      color: "neutral",
      icon: "i-lucide-mic-off",
    });
  }
}

function turnMenu(turn: SpeakingTurnDto): DropdownMenuItem[][] {
  return [
    [
      {
        label: t("session.speakers.giveNow"),
        icon: "i-lucide-mic",
        onSelect: () => void giveFloorNow(turn),
      },
      renameItem(turn),
    ],
    [
      {
        label: t("session.speakers.remove"),
        icon: "i-lucide-x",
        color: "error",
        onSelect: () => void speakers.remove(turn),
      },
    ],
  ];
}

/** The floor given by mistake goes back; a name is corrected. */
function speakingMenu(turn: SpeakingTurnDto): DropdownMenuItem[][] {
  return [
    [
      {
        label: t("session.speakers.backToQueue"),
        icon: "i-lucide-undo-2",
        onSelect: () => void speakers.returnToQueue(turn),
      },
      renameItem(turn),
    ],
  ];
}

// Correcting a name ------------------------------------------------------------

// The dialog's state lives in the console, so the shortcuts pause while it
// is open.
const renameDialog = session.speakerRenameDialog;
const renameOpen = computed({
  get: () => renameDialog.open,
  set: (value: boolean) => {
    renameDialog.open = value;
  },
});
const renameTarget = computed(() => renameDialog.turn);
const renameValue = ref("");
watch(
  () => renameDialog.open,
  (isOpen) => {
    if (isOpen) renameValue.value = renameDialog.turn?.speaker ?? "";
  },
);
const renaming = computed(() =>
  renameTarget.value ? busyFor(renameTarget.value) : false,
);
/**
 * Something to save: a different name, and never no name at all for a
 * turn without a member (the server needs one of the two).
 */
const canRename = computed(() => {
  const target = renameTarget.value;
  if (!target || renaming.value) return false;
  const value = renameValue.value.trim();
  if (value === (target.speaker ?? "")) return false;
  return value !== "" || target.member !== null;
});

async function saveRename(): Promise<void> {
  const target = renameTarget.value;
  if (!target || !canRename.value) return;
  if (await speakers.rename(target, renameValue.value)) {
    renameOpen.value = false;
  }
}

// Reordering -----------------------------------------------------------------

const reordering = ref(false);
watch(
  () => waiting.value.length,
  (count) => {
    if (count < 2) reordering.value = false;
  },
);

function buttonId(turn: SpeakingTurnDto, direction: "up" | "down"): string {
  return `session-speaker-${turn.id}-${direction}`;
}

/**
 * Moves a turn one place and keeps the focus on it, so pressing the same
 * key again keeps moving it. At either end the focus goes to the button
 * that still works.
 */
async function move(turn: SpeakingTurnDto, step: 1 | -1): Promise<void> {
  if (busyFor(turn)) return;
  await speakers.move(turn, step);
  await nextTick();
  const index = waiting.value.findIndex((other) => other.id === turn.id);
  if (index === -1) return;
  const atEnd = step === -1 ? index === 0 : index === waiting.value.length - 1;
  const direction = (step === -1) !== atEnd ? "up" : "down";
  window.document.getElementById(buttonId(turn, direction))?.focus();
}

// Who already spoke ------------------------------------------------------------

const doneOpen = ref(false);

// Screen readers ---------------------------------------------------------------

/**
 * One region that is always there says who has the floor, so a change
 * made from another Mesa device is announced too.
 */
const announcement = computed(() =>
  speaking.value
    ? t("session.speakers.summarySpeaking", { who: who(speaking.value) })
    : t("session.speakers.nobodySpeaking"),
);

function duration(turn: SpeakingTurnDto): string | null {
  const seconds = sessionTurnDuration(turn);
  return seconds === null ? null : sessionFormatDuration(seconds);
}
</script>

<template>
  <div class="space-y-4">
    <p class="sr-only" aria-live="polite" aria-atomic="true">
      {{ speakers.loading.value ? "" : announcement }}
    </p>

    <div v-if="speakers.loading.value" class="space-y-2" role="status">
      <span class="sr-only">{{ t("common.loading") }}</span>
      <USkeleton aria-hidden="true" class="h-20 w-full" />
      <USkeleton aria-hidden="true" class="h-10 w-full" />
    </div>

    <UAlert
      v-else-if="speakers.unavailable.value"
      color="neutral"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('session.speakers.loadError')"
      :actions="[
        {
          label: t('session.actions.retry'),
          color: 'neutral',
          variant: 'outline',
          onClick: () => {
            void speakers.refresh();
          },
        },
      ]"
    />

    <template v-else>
      <p
        v-if="speakers.failed.value"
        class="text-muted flex items-center gap-1.5 text-xs"
        role="status"
      >
        <UIcon
          name="i-lucide-cloud-off"
          class="size-3.5 shrink-0"
          aria-hidden="true"
        />
        {{ t("session.speakers.stale") }}
      </p>

      <!-- Who has the floor, and the one next step. -->
      <section
        class="rounded-lg border p-3"
        :class="speaking ? 'border-primary/50 bg-primary/5' : 'border-default'"
        :aria-label="t('session.speakers.floor')"
      >
        <template v-if="speaking">
          <p class="text-muted text-xs">{{ t("session.speakers.speaking") }}</p>
          <div class="mt-1 flex items-center gap-3">
            <p class="text-highlighted min-w-0 flex-1 text-lg font-semibold">
              <span class="flex flex-wrap items-center gap-2">
                <CommonMemberBadge
                  v-if="speaking.member"
                  :member="speaking.member"
                  size="md"
                />
                <span v-if="speaking.speaker" class="min-w-0 truncate">
                  {{ speaking.speaker }}
                </span>
                <span v-else-if="!speaking.member">
                  {{ t("session.speakers.unnamed") }}
                </span>
              </span>
            </p>
            <SessionSpeakerTimer
              :started-at="speaking.startedAt"
              class="text-highlighted text-2xl font-semibold"
            />
            <UDropdownMenu
              :items="speakingMenu(speaking)"
              :content="{ align: 'end' }"
            >
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-lucide-ellipsis"
                :aria-label="t('session.speakers.more', { who: who(speaking) })"
                :loading="busyFor(speaking)"
                :disabled="anyTurnBusy"
              />
            </UDropdownMenu>
          </div>
        </template>
        <p v-else class="text-default text-sm">
          {{
            firstWaiting
              ? t("session.speakers.nobodySpeaking")
              : t("session.speakers.empty")
          }}
        </p>

        <div v-if="mainAction" class="mt-3 flex flex-wrap gap-2">
          <UButton
            :icon="mainAction.icon"
            :label="mainAction.label"
            :loading="mainAction.busy"
            :disabled="anyTurnBusy"
            @click="speakers.next()"
          />
          <UButton
            v-if="speaking && firstWaiting"
            color="neutral"
            variant="outline"
            icon="i-lucide-mic-off"
            :label="t('session.speakers.finish')"
            :disabled="anyTurnBusy"
            @click="speakers.finish(speaking)"
          />
        </div>
      </section>

      <!-- Write a turn down: member search, optional person, Enter. -->
      <form
        class="space-y-2"
        :aria-label="t('session.speakers.addTitle')"
        @submit.prevent="addTurn"
      >
        <UFormField
          :label="t('session.speakers.member')"
          name="session-speaker-member"
        >
          <UInputMenu
            ref="memberInput"
            v-model="memberId"
            :items="memberItems"
            value-key="value"
            :loading="membersStatus === 'pending'"
            :placeholder="t('session.speakers.memberPlaceholder')"
            icon="i-lucide-search"
            :trailing="false"
            open-on-click
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('session.speakers.person')"
          :hint="t('session.vote.optional')"
          name="session-speaker-name"
        >
          <UInput
            v-model="speakerName"
            :maxlength="SPEAKER_NAME_MAX_LENGTH"
            autocomplete="off"
            class="w-full"
          />
        </UFormField>
        <UButton
          type="submit"
          block
          color="neutral"
          variant="soft"
          icon="i-lucide-plus"
          :label="t('session.speakers.add')"
          :loading="adding"
          :disabled="!canAdd"
        />
      </form>

      <!-- Waiting turns. -->
      <section class="space-y-2" aria-labelledby="session-speakers-waiting">
        <div class="flex items-center gap-2">
          <h3
            id="session-speakers-waiting"
            class="text-highlighted text-sm font-semibold"
          >
            {{
              t(
                "session.speakers.waiting",
                { count: waiting.length },
                waiting.length,
              )
            }}
          </h3>
          <UButton
            v-if="waiting.length >= 2"
            class="ms-auto"
            size="xs"
            color="neutral"
            variant="ghost"
            :icon="reordering ? 'i-lucide-check' : 'i-lucide-arrow-up-down'"
            :label="
              reordering
                ? t('session.speakers.reorderDone')
                : t('session.speakers.reorder')
            "
            :aria-pressed="reordering"
            @click="reordering = !reordering"
          />
        </div>
        <p v-if="waiting.length === 0" class="text-muted text-sm">
          {{ t("session.speakers.waitingEmpty") }}
        </p>
        <ol
          v-else
          class="border-default divide-default divide-y rounded-lg border"
        >
          <li
            v-for="(turn, index) in waiting"
            :key="turn.id"
            class="flex min-h-11 items-center gap-2 px-2 py-1"
          >
            <span
              class="text-muted w-5 shrink-0 text-end text-sm tabular-nums"
              aria-hidden="true"
            >
              {{ index + 1 }}
            </span>
            <span class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              <CommonMemberBadge
                v-if="turn.member"
                :member="turn.member"
                size="sm"
              />
              <span
                v-if="turn.speaker || !turn.member"
                class="text-default min-w-0 truncate text-sm"
              >
                {{ turn.speaker ?? t("session.speakers.unnamed") }}
              </span>
            </span>
            <template v-if="reordering">
              <UButton
                :id="buttonId(turn, 'up')"
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-lucide-arrow-up"
                :aria-label="t('session.speakers.moveUp', { who: who(turn) })"
                :disabled="index === 0"
                @click="move(turn, -1)"
              />
              <UButton
                :id="buttonId(turn, 'down')"
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-lucide-arrow-down"
                :aria-label="t('session.speakers.moveDown', { who: who(turn) })"
                :disabled="index === waiting.length - 1"
                @click="move(turn, 1)"
              />
            </template>
            <UDropdownMenu
              v-else
              :items="turnMenu(turn)"
              :content="{ align: 'end' }"
            >
              <UButton
                size="sm"
                color="neutral"
                variant="ghost"
                icon="i-lucide-ellipsis"
                :aria-label="t('session.speakers.more', { who: who(turn) })"
                :loading="busyFor(turn)"
              />
            </UDropdownMenu>
          </li>
        </ol>
      </section>

      <!-- Who already spoke on this item, folded away. -->
      <section v-if="done.length > 0">
        <UButton
          color="neutral"
          variant="link"
          size="sm"
          class="px-0"
          :trailing-icon="
            doneOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
          "
          :label="
            t('session.speakers.done', { count: done.length }, done.length)
          "
          :aria-expanded="doneOpen"
          aria-controls="session-speakers-done"
          @click="doneOpen = !doneOpen"
        />
        <ul
          v-show="doneOpen"
          id="session-speakers-done"
          class="text-muted mt-1 space-y-1 text-sm"
        >
          <li
            v-for="turn in done"
            :key="turn.id"
            class="flex items-center gap-2"
          >
            <span class="min-w-0 flex-1 truncate">{{ who(turn) }}</span>
            <span v-if="duration(turn)" class="tabular-nums">
              {{ duration(turn) }}
            </span>
          </li>
        </ul>
      </section>
    </template>

    <!-- Who sees the turns: the Mesa decides. A setting, so it comes last. -->
    <div class="border-default border-t pt-3">
      <USwitch
        :model-value="visible"
        :loading="visibleBusy"
        :disabled="visibleBusy"
        :label="t('session.speakers.visible')"
        :description="
          visible
            ? t('session.speakers.visibleOn')
            : t('session.speakers.visibleOff')
        "
        @update:model-value="setVisible"
      />
    </div>

    <UModal
      v-model:open="renameOpen"
      :title="t('session.speakers.renameTitle')"
      :description="
        renameTarget
          ? t('session.speakers.renameHint', { who: who(renameTarget) })
          : undefined
      "
    >
      <template #body>
        <form
          id="session-speaker-rename"
          class="space-y-3"
          @submit.prevent="saveRename"
        >
          <UFormField
            :label="t('session.speakers.person')"
            :hint="
              renameTarget?.member ? t('session.vote.optional') : undefined
            "
            name="session-speaker-rename"
          >
            <UInput
              v-model="renameValue"
              :maxlength="SPEAKER_NAME_MAX_LENGTH"
              autocomplete="off"
              autofocus
              class="w-full"
            />
          </UFormField>
        </form>
      </template>
      <template #footer="{ close }">
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            :label="t('common.cancel')"
            @click="close"
          />
          <UButton
            type="submit"
            form="session-speaker-rename"
            icon="i-lucide-check"
            :label="t('common.save')"
            :loading="renaming"
            :disabled="!canRename"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
