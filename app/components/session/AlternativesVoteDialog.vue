<script setup lang="ts">
import type { VoteMethod } from "~~/shared/constants/domain";
import { amendmentVoteMajority } from "~~/shared/constants/domain";
import {
  ALTERNATIVES_OPTION_COUNT,
  alternativeLetter,
  computeAlternativesOutcome,
  type AlternativesTieResolution,
  type AlternativesWinnerOutcome,
} from "~~/shared/utils/alternativesVote";
import {
  alternativesSplitConflict,
  followsProjectedSplit,
  sameAlternatives,
} from "~~/shared/utils/alternativesSplit";
import { amendmentsMeet } from "~~/shared/utils/content/passages";
import type { LiveTally, LiveTallyReveal } from "~~/shared/types/api";
import {
  rollCallCounts,
  rollCallVoters,
  type VoteBallotInput,
} from "~~/shared/utils/rollCall";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { sessionTallyRepeatDue } from "~/composables/session/liveTally";
import { sessionAlternativesCounted } from "~/composables/session/dirtyDialog";
import { useDirtyDialog } from "~/composables/session/useDirtyDialog";

/**
 * A vote between alternatives (user's decisions of 2026-11-20): the
 * amendments chosen in the bloc are split into «Opción A» and «Opción B»,
 * which the console in control may put on screen; then the Mesa records
 * the votes of each option and the abstentions (blank and invalid ballots
 * in a secret vote). The option with most votes wins (and, in the
 * Estatutos and the regulations, must reach the absolute majority): its
 * amendments are approved and the others rejected. When none wins, the
 * Mesa chooses: reject them all, repeat the vote, or leave them undecided.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();
const toast = useToast();
const alternativesText = useAlternativesVoteText();

const open = computed({
  get: () => session.alternativesDialog.open,
  set: (value: boolean) => {
    session.alternativesDialog.open = value;
  },
});

/** Each amendment's option (its index), or null while unassigned. */
const choice = ref<Record<string, number | null>>({});
const METHODS = ["show_of_hands", "roll_call", "secret", "portal"] as const;
const method = ref<Exclude<VoteMethod, "assent">>("show_of_hands");
const counts = ref<number[]>([0, 0]);
const abstentions = ref(0);
const blank = ref(0);
const invalid = ref(0);
const present = ref<number | null>(null);
const note = ref("");
/**
 * What a win does to the winning option (user's decision of 2026-11-21):
 * approve it, or only reject the other and vote the winner next against
 * the original text.
 */
const winnerOutcome = ref<AlternativesWinnerOutcome>("approve");
/** The server found no winner (the members present may differ). */
const serverUndecided = ref<"tie" | "short" | null>(null);
const busy = ref(false);

/** Each amendment's option in `options`, or null without them. */
function seedChoice(
  ids: string[],
  options: string[][] | null,
): Record<string, number | null> {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      options ? options.findIndex((option) => option.includes(id)) : null,
    ]),
  );
}

watch(open, (value) => {
  if (!value) return;
  choice.value = seedChoice(
    session.alternativesDialog.ids,
    session.alternativesDialog.options,
  );
  method.value = "show_of_hands";
  winnerOutcome.value = "approve";
  resetCounts();
  note.value = "";
});

// The room votes on the options on screen, and the server refuses another
// split of them: when the console in control moves these same amendments to
// another split while this dialog is open, the dialog takes it, keeping the
// counts, and says so once (followsProjectedSplit). A projection of other
// amendments, or of more or fewer, leaves the dialog alone.
watch(
  () => session.roomAlternatives.value,
  (next, previous) => {
    if (!open.value || !next) return;
    if (
      !followsProjectedSplit(
        next,
        previous,
        options.value,
        session.alternativesDialog.ids,
      )
    ) {
      return;
    }
    session.alternativesDialog.ids = next.flat();
    session.alternativesDialog.options = next.map((option) => [...option]);
    choice.value = seedChoice(next.flat(), next);
    serverUndecided.value = null;
    toast.add({
      id: "session-alternatives-split",
      title: t("session.alternatives.splitUpdated"),
      color: "info",
      icon: "i-lucide-monitor",
    });
  },
);

// A registered vote: each delegation of the latest headcount chooses an
// option, abstains or does not vote (user's decision of 2026-11-21); the
// counts follow, as the server takes them.
const ballots = ref<VoteBallotInput[]>([]);
const rollCallList = computed(() =>
  method.value === "roll_call" && session.voteHeadcount.value
    ? rollCallVoters(session.voteHeadcount.value.entries)
    : [],
);
const rollCall = computed(() => rollCallList.value.length > 0);
const rollCallChoices = computed(() => [
  ...Array.from({ length: ALTERNATIVES_OPTION_COUNT }, (_, index) => ({
    choice: "option" as const,
    option: index,
    label: alternativesText.optionName(index),
  })),
  { choice: "abstention" as const, label: t("session.vote.abstentions") },
  { choice: "not_voting" as const, label: t("session.rollCall.notVoting") },
]);
watch(
  ballots,
  (list) => {
    if (!rollCall.value) return;
    const byMember = new Map(list.map((ballot) => [ballot.memberId, ballot]));
    const tally = rollCallCounts(
      rollCallList.value.map((voter) => {
        const ballot = byMember.get(voter.memberId);
        return {
          choice: ballot?.choice ?? "not_voting",
          option: ballot?.option ?? null,
        };
      }),
      ALTERNATIVES_OPTION_COUNT,
    );
    counts.value = tally.options;
    abstentions.value = tally.abstentions;
    present.value = tally.present;
    serverUndecided.value = null;
  },
  { deep: true },
);
watch(method, (value) => {
  if (value !== "roll_call") ballots.value = [];
  if (value !== "secret") reveal.value = null;
});

// A secret vote announced on screen (user's decision of 2026-11-21) ----------

/**
 * How the room follows a secret vote's count, as in every vote form: at
 * the end with the result, or ballot by ballot, each option's tile and the
 * blank and invalid ones. Nothing is counted, nor announced, until the Mesa
 * picks one; only from the console of an open session.
 */
const reveal = ref<LiveTallyReveal | null>(null);
const revealOffered = computed(
  () => method.value === "secret" && session.inSession.value,
);
const revealPending = computed(() => revealOffered.value && !reveal.value);
const liveCount = computed(
  () => revealOffered.value && reveal.value === "live",
);
/**
 * The last ballot added or taken back, said once to screen readers with
 * whose it is («Alternativa A: 5, uno más»), never a bare count, as in
 * ElectionFields (E-123).
 */
const spoken = ref("");
watch(liveCount, () => {
  spoken.value = "";
});
function addBallot(index: number | "blank" | "invalid", step: 1 | -1): void {
  let next: number;
  let name: string;
  if (index === "blank") {
    next = Math.max(0, blank.value + step);
    blank.value = next;
    name = t("amendment.vote.blank");
  } else if (index === "invalid") {
    next = Math.max(0, invalid.value + step);
    invalid.value = next;
    name = t("amendment.vote.invalid");
  } else {
    const all = [...counts.value];
    next = Math.max(0, (all[index] ?? 0) + step);
    all[index] = next;
    counts.value = all;
    name = alternativesText.optionName(index);
  }
  serverUndecided.value = null;
  spoken.value = t(
    step === 1 ? "session.election.countUp" : "session.election.countDown",
    { name, count: next },
  );
}
/** What the projection shows while the secret vote is counted. */
const announcement = computed<LiveTally | null>(() => {
  if (!open.value || !revealOffered.value || !reveal.value) return null;
  return {
    subject: { type: "decision", id: null },
    question: [
      t("amendment.vote.alternatives.title"),
      ...options.value.map(
        (ids, index) =>
          `${alternativesText.optionName(index)}: ${ids
            .map((id) => session.label(id))
            .join(", ")}`,
      ),
    ].join(" · "),
    method: "secret",
    reveal: reveal.value,
    counts:
      reveal.value === "live"
        ? { inFavor: 0, against: 0, blank: blank.value, invalid: invalid.value }
        : null,
    options: reveal.value === "live" ? [...counts.value] : null,
    present: presentForOutcome.value,
    majority: majority.value,
  };
});
let tallyShown = false;
watch(
  announcement,
  (tally) => {
    if (tally) {
      session.pushTally(tally);
      tallyShown = true;
    } else if (tallyShown) {
      session.pushTally(null);
      tallyShown = false;
    }
  },
  { deep: true },
);
// The server keeps it in memory for 90 s: sent again while counting, but
// not while the vote is being recorded (sessionTallyRepeatDue, as in
// VoteFields and ElectionFields), at most one repeat skipped in a row.
let repeatSkipped = false;
useIntervalFn(() => {
  if (!announcement.value) return;
  const saving = busy.value || Object.values(session.busy.value).some(Boolean);
  if (!sessionTallyRepeatDue({ busy: saving, skippedLast: repeatSkipped })) {
    repeatSkipped = true;
    return;
  }
  repeatSkipped = false;
  session.pushTally(announcement.value);
}, 15_000);
onBeforeUnmount(() => {
  if (tallyShown) session.pushTally(null);
});

function resetCounts(): void {
  ballots.value = [];
  reveal.value = null;
  counts.value = Array.from({ length: ALTERNATIVES_OPTION_COUNT }, () => 0);
  abstentions.value = 0;
  blank.value = 0;
  invalid.value = 0;
  present.value = null;
  serverUndecided.value = null;
}

const ids = computed(() => session.alternativesDialog.ids);
const options = computed(() =>
  Array.from({ length: ALTERNATIVES_OPTION_COUNT }, (_, index) =>
    ids.value.filter((id) => choice.value[id] === index),
  ),
);
const unassigned = computed(() =>
  ids.value.filter((id) => choice.value[id] == null),
);
const ready = computed(
  () =>
    unassigned.value.length === 0 &&
    options.value.every((option) => option.length > 0),
);

/** Amendments of one option that collide with each other: worth a look. */
const collisions = computed(() =>
  options.value.flatMap((option, index) => {
    const pairs: string[] = [];
    for (let i = 0; i < option.length; i++) {
      for (let j = i + 1; j < option.length; j++) {
        const a = session.byId.value.get(option[i]!);
        const b = session.byId.value.get(option[j]!);
        if (a && b && amendmentsMeet(a.ops, b.ops)) {
          pairs.push(
            t("session.alternatives.collision", {
              option: alternativesText.optionName(index),
              a: session.label(a.id),
              b: session.label(b.id),
            }),
          );
        }
      }
    }
    return pairs;
  }),
);

const onScreen = computed(
  () =>
    session.roomAlternatives.value !== null &&
    sameAlternatives(session.roomAlternatives.value, options.value),
);
/** Options on screen split otherwise: the server would refuse the vote. */
const splitDiffers = computed(() =>
  alternativesSplitConflict(session.roomAlternatives.value, options.value),
);

const majority = computed(() =>
  session.document.value
    ? amendmentVoteMajority(session.document.value.kind)
    : "simple",
);
const presentForOutcome = computed(
  () => present.value ?? session.voteHeadcount.value?.present ?? null,
);
const outcome = computed(() =>
  computeAlternativesOutcome(
    {
      options: counts.value,
      abstentions: method.value === "secret" ? 0 : abstentions.value,
      blank: method.value === "secret" ? blank.value : 0,
      invalid: method.value === "secret" ? invalid.value : 0,
      present: presentForOutcome.value,
    },
    majority.value,
    session.settings.value,
  ),
);
const counted = computed(
  () =>
    counts.value.some((value) => value > 0) ||
    abstentions.value + blank.value + invalid.value > 0,
);
/** No option wins: the Mesa chooses what happens. */
const undecided = computed<"tie" | "short" | null>(
  () =>
    serverUndecided.value ?? (counted.value ? outcome.value.undecided : null),
);
const preview = computed(() => {
  if (!counted.value) return null;
  if (outcome.value.inconsistent) return t("session.alternatives.inconsistent");
  if (outcome.value.winner !== null) {
    return t(
      winnerOutcome.value === "keep"
        ? "session.alternatives.winsPreviewKeep"
        : "session.alternatives.winsPreview",
      { letter: alternativeLetter(outcome.value.winner) },
    );
  }
  return outcome.value.undecided === "short"
    ? t("session.alternatives.shortPreview", {
        threshold: outcome.value.threshold ?? 0,
      })
    : t("session.alternatives.tiePreview");
});

function assign(id: string, index: number): void {
  choice.value = { ...choice.value, [id]: index };
  serverUndecided.value = null;
}

async function project(): Promise<void> {
  await session.projectAlternatives(options.value);
}

async function record(tieResolution?: AlternativesTieResolution) {
  if (!ready.value || busy.value) return;
  busy.value = true;
  try {
    const result = await session.voteAlternatives({
      method: method.value,
      options: options.value.map((ids, index) => ({
        ids,
        count: counts.value[index] ?? 0,
      })),
      abstentions: abstentions.value,
      blank: blank.value,
      invalid: invalid.value,
      present: present.value,
      note: note.value.trim() || null,
      tieResolution,
      winnerOutcome: winnerOutcome.value,
      ballots: rollCall.value ? ballots.value : undefined,
      rollCallHeadcountId: rollCall.value
        ? session.voteHeadcount.value?.id
        : undefined,
    });
    if (result.ok) {
      open.value = false;
    } else if (result.undecided) {
      serverUndecided.value = result.undecided;
    }
  } finally {
    busy.value = false;
  }
}

// Counted votes, ballots or a roll call under way are not lost by a stray
// Escape or click outside; the X and «Cancelar» ask first (E-127).
const { dismissible, onOpenUpdate } = useDirtyDialog({
  open,
  dirty: () =>
    sessionAlternativesCounted({
      counts: counts.value,
      abstentions: abstentions.value,
      blank: blank.value,
      invalid: invalid.value,
      ballots: ballots.value,
    }),
  question: () => ({
    title: t("session.discard.voteTitle"),
    description: t("session.discard.voteDescription"),
  }),
  confirm: session.confirm,
});

function amendmentLine(id: string): string {
  const amendment = session.byId.value.get(id);
  const authors =
    amendment?.authors.map((author) => author.acronym).join(", ") ?? "";
  return authors ? `${session.label(id)} · ${authors}` : session.label(id);
}
</script>

<template>
  <UModal
    :open="open"
    :dismissible="dismissible"
    :title="t('session.alternatives.title')"
    :description="t('session.alternatives.description')"
    :ui="{ content: 'sm:max-w-3xl' }"
    @update:open="onOpenUpdate"
  >
    <template #body>
      <div class="space-y-5">
        <!-- 1. The options -->
        <section class="space-y-2">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.alternatives.optionsTitle") }}
          </h3>
          <ul class="border-default divide-default divide-y rounded-lg border">
            <li
              v-for="id in ids"
              :key="id"
              class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <span class="text-highlighted min-w-0 font-medium">
                <AmendmentCodeLinks :ids="[id]" :label-of="amendmentLine" />
              </span>
              <UFieldGroup size="xs">
                <UButton
                  v-for="index in ALTERNATIVES_OPTION_COUNT"
                  :key="index"
                  :label="alternativesText.optionName(index - 1)"
                  :color="choice[id] === index - 1 ? 'primary' : 'neutral'"
                  :variant="choice[id] === index - 1 ? 'solid' : 'outline'"
                  :aria-pressed="choice[id] === index - 1"
                  @click="assign(id, index - 1)"
                />
              </UFieldGroup>
            </li>
          </ul>
          <div class="grid gap-2 sm:grid-cols-2">
            <div
              v-for="(option, index) in options"
              :key="index"
              class="border-default rounded-lg border px-3 py-2 text-sm"
            >
              <p class="text-highlighted font-semibold">
                {{ alternativesText.optionName(index) }}
              </p>
              <p class="text-muted">
                {{
                  option.length > 0
                    ? option.map((id) => session.label(id)).join(", ")
                    : t("session.alternatives.emptyOption")
                }}
              </p>
            </div>
          </div>
          <UAlert
            v-if="collisions.length > 0"
            color="warning"
            variant="subtle"
            icon="i-lucide-git-compare"
            :title="t('session.alternatives.collisionsTitle')"
            :description="collisions.join(' · ')"
          />
          <div
            v-if="session.inControl.value"
            class="flex flex-wrap items-center gap-2"
          >
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              icon="i-lucide-monitor-up"
              :label="
                onScreen
                  ? t('session.alternatives.onScreen')
                  : t('session.alternatives.project')
              "
              :disabled="!ready || onScreen"
              @click="project"
            />
          </div>
          <!-- Without the control, only what the room sees. -->
          <UBadge
            v-else-if="onScreen"
            color="neutral"
            variant="subtle"
            icon="i-lucide-monitor"
            :label="t('session.alternatives.onScreen')"
          />
          <p
            v-if="splitDiffers"
            class="text-warning flex items-start gap-1.5 text-sm"
            role="status"
          >
            <UIcon
              name="i-lucide-monitor-x"
              class="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            {{ t("session.alternatives.errors.splitChanged") }}
          </p>
        </section>

        <!-- 2. The votes -->
        <section class="space-y-3">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.alternatives.countsTitle") }}
          </h3>
          <URadioGroup
            v-model="winnerOutcome"
            :legend="t('session.alternatives.winnerOutcome')"
            :items="[
              {
                value: 'approve',
                label: t('session.alternatives.winnerApprove'),
              },
              {
                value: 'keep',
                label: t('session.alternatives.winnerKeep'),
              },
            ]"
          />
          <UFormField :label="t('session.alternatives.method')">
            <USelect
              v-model="method"
              :items="
                METHODS.map((value) => ({
                  value,
                  label: t(`amendment.vote.methods.${value}`),
                }))
              "
              class="w-full sm:w-64"
            />
          </UFormField>
          <!-- A secret vote in the console: how the room follows the count. -->
          <div v-if="revealOffered" class="space-y-2">
            <URadioGroup
              :model-value="reveal ?? undefined"
              :legend="t('session.vote.reveal.label')"
              :items="[
                {
                  value: 'end',
                  label: t('session.vote.reveal.end'),
                  description: t('session.vote.reveal.endHint'),
                },
                {
                  value: 'live',
                  label: t('session.vote.reveal.live'),
                  description: t('session.vote.reveal.liveHint'),
                },
              ]"
              variant="card"
              :ui="{ fieldset: 'grid gap-2 sm:grid-cols-2' }"
              @update:model-value="
                (value) => (reveal = value as LiveTallyReveal)
              "
            />
            <p v-if="revealPending" class="text-muted text-sm">
              {{ t("session.vote.reveal.pending") }}
            </p>
            <p v-else-if="!session.inControl.value" class="text-muted text-xs">
              {{ t("session.vote.reveal.notProjected") }}
            </p>
          </div>
          <!-- Counted live: one tile per option and per blank or invalid ballot. -->
          <div v-if="liveCount" class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <!-- Mounted with the tiles, before the first ballot, so it is
                 heard; out of the flow, it takes no cell. -->
            <p class="sr-only" aria-live="polite">{{ spoken }}</p>
            <div
              v-for="tile in [
                ...counts.map((count, index) => ({
                  key: index as number | 'blank' | 'invalid',
                  label: alternativesText.optionName(index),
                  count,
                })),
                {
                  key: 'blank' as const,
                  label: t('amendment.vote.blank'),
                  count: blank,
                },
                {
                  key: 'invalid' as const,
                  label: t('amendment.vote.invalid'),
                  count: invalid,
                },
              ]"
              :key="String(tile.key)"
              class="border-default flex flex-col items-center gap-2 rounded-lg border p-3"
            >
              <span class="text-muted text-sm font-medium">{{
                tile.label
              }}</span>
              <span class="text-highlighted text-3xl font-bold tabular-nums">
                {{ tile.count }}
              </span>
              <div class="flex items-center gap-1">
                <UButton
                  size="lg"
                  icon="i-lucide-plus"
                  :label="t('session.vote.addBallot')"
                  :aria-label="
                    t('session.vote.addBallotFor', { option: tile.label })
                  "
                  @click="addBallot(tile.key, 1)"
                />
                <UButton
                  color="neutral"
                  variant="ghost"
                  icon="i-lucide-minus"
                  :aria-label="
                    t('session.vote.removeBallotFor', { option: tile.label })
                  "
                  :disabled="tile.count === 0"
                  @click="addBallot(tile.key, -1)"
                />
              </div>
            </div>
          </div>
          <!-- A registered vote: each delegation of the latest headcount. -->
          <SessionRollCallBallots
            v-else-if="rollCall"
            v-model="ballots"
            :voters="rollCallList"
            :choices="rollCallChoices"
          />
          <div
            v-else-if="!revealPending"
            class="grid grid-cols-2 gap-3 sm:grid-cols-4"
          >
            <UFormField
              v-for="(_, index) in counts"
              :key="index"
              :label="alternativesText.optionName(index)"
            >
              <UInputNumber
                :model-value="counts[index] ?? 0"
                :min="0"
                :max="100000"
                class="w-full"
                @update:model-value="
                  (value) => {
                    counts[index] = value ?? 0;
                    serverUndecided = null;
                  }
                "
              />
            </UFormField>
            <template v-if="method === 'secret'">
              <UFormField :label="t('amendment.vote.blank')">
                <UInputNumber
                  v-model="blank"
                  :min="0"
                  :max="100000"
                  class="w-full"
                />
              </UFormField>
              <UFormField :label="t('amendment.vote.invalid')">
                <UInputNumber
                  v-model="invalid"
                  :min="0"
                  :max="100000"
                  class="w-full"
                />
              </UFormField>
            </template>
            <UFormField v-else :label="t('amendment.vote.abstentions')">
              <UInputNumber
                v-model="abstentions"
                :min="0"
                :max="100000"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="t('amendment.vote.present')"
              :hint="
                session.voteHeadcount.value
                  ? String(session.voteHeadcount.value.present)
                  : undefined
              "
            >
              <UInputNumber
                :model-value="present ?? undefined"
                :min="0"
                :max="100000"
                :placeholder="
                  session.voteHeadcount.value
                    ? String(session.voteHeadcount.value.present)
                    : ''
                "
                class="w-full"
                @update:model-value="(value) => (present = value ?? null)"
              />
            </UFormField>
          </div>
          <UFormField :label="t('session.alternatives.note')">
            <UTextarea v-model="note" :rows="2" class="w-full" autoresize />
          </UFormField>
          <p
            v-if="preview"
            class="text-sm font-medium"
            :class="
              outcome.inconsistent || undecided
                ? 'text-warning'
                : 'text-success'
            "
            aria-live="polite"
          >
            {{ preview }}
            <template v-if="majority !== 'simple'">
              · {{ t(`amendment.vote.majorities.${majority}`) }}
            </template>
          </p>
          <UAlert
            v-if="undecided"
            color="warning"
            variant="subtle"
            icon="i-lucide-scale"
            :title="
              undecided === 'short'
                ? t('session.alternatives.shortTitle')
                : t('session.alternatives.tieTitle')
            "
            :description="t('session.alternatives.undecidedDescription')"
          />
        </section>
      </div>
    </template>
    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="close"
        />
        <template v-if="undecided">
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-rotate-ccw"
            :label="t('session.alternatives.repeat')"
            @click="resetCounts"
          />
          <UButton
            color="neutral"
            variant="outline"
            icon="i-lucide-pause"
            :label="t('session.alternatives.noEffect')"
            :loading="busy"
            :disabled="!ready || outcome.inconsistent"
            @click="record('no_effect')"
          />
          <UButton
            color="error"
            icon="i-lucide-x"
            :label="t('session.alternatives.rejectAll')"
            :loading="busy"
            :disabled="!ready || outcome.inconsistent"
            @click="record('reject_all')"
          />
        </template>
        <UButton
          v-else
          color="primary"
          icon="i-lucide-check"
          :label="t('session.alternatives.record')"
          :loading="busy"
          :disabled="!ready || !counted || outcome.inconsistent"
          @click="record()"
        />
      </div>
    </template>
  </UModal>
</template>
