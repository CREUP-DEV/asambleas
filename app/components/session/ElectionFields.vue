<script setup lang="ts">
import type { HeadcountDto } from "~~/shared/types/api";
import type { AssemblySettings, VoteMethod } from "~~/shared/constants/domain";
import {
  computeElectionOutcome,
  ELECTION_CANDIDATE_MAX_LENGTH,
  ELECTION_MAX_CANDIDATES,
  ELECTION_RULES,
  type ElectionInput,
} from "~~/shared/utils/election";
import { useOptionalSessionConsole } from "~/composables/session/useSessionConsole";
import {
  sessionElectionTally,
  sessionTallyRepeatDue,
  type LiveTallyAnnounce,
} from "~/composables/session/liveTally";

/**
 * An election in an agenda item's vote (user's decisions of 2026-11-21):
 * the candidates, the posts (the most that may be elected), the most each
 * ballot may mark (not necessarily the posts), the rule (the
 * absolute majority with a second round, as the CAS and the CAI elect, or
 * a simple majority), each candidate's votes and the ballots that marked
 * someone (worked out with one post), then blank and invalid ballots in a
 * secret vote or abstentions by show of hands. The preview says who is
 * elected, or who goes to a second round.
 *
 * In the console of an open session, «Mostrar el recuento en la
 * proyección» (`projected`, the dialog's switch beside «Es una elección»;
 * off by default, any method; user's decision of 2026-11-21) puts the
 * count on screen: each candidate gets a tile that adds a vote,
 * and the projection shows each candidate's votes as they are entered
 * (sessionElectionTally), sent again every 15 s while the switch is on and
 * the form open, and taken off when it is turned off or the form closes.
 * Off, the votes are typed in and nothing reaches the screen until the
 * result. Counted on screen, the keys 1 to 9 add a vote to the tiles in
 * their order (user's decision of 2026-11-21), unless single-key shortcuts
 * are off (WCAG 2.1.4) or the focus is in a field, and «Deshacer el
 * último» takes the last one back.
 */
const props = defineProps<{
  settings: Pick<AssemblySettings, "denominator">;
  headcount?: HeadcountDto | null;
  /** Secret: blank and invalid ballots; otherwise abstentions. */
  secret: boolean;
  /** How it is voted, for the projection. */
  method: VoteMethod;
  /** What is voted, for the projection's announcement of the count. */
  announce?: LiveTallyAnnounce | null;
}>();

const election = defineModel<ElectionInput>({ required: true });
const blank = defineModel<number>("blank", { required: true });
const invalid = defineModel<number>("invalid", { required: true });
const abstentions = defineModel<number>("abstentions", { required: true });
/** «Mostrar el recuento en la proyección», the dialog's switch. */
const projected = defineModel<boolean>("projected", { default: false });

const { t } = useI18n();

function update(next: Partial<ElectionInput>): void {
  const merged = { ...election.value, ...next };
  // With one mark per ballot, the ballots that marked someone are the votes.
  if (merged.maxChoices === 1) {
    merged.ballots = merged.counts.reduce((sum, value) => sum + value, 0);
  }
  election.value = merged;
}
function setCandidate(index: number, value: string): void {
  const candidates = [...election.value.candidates];
  candidates[index] = value;
  update({ candidates });
}
function addCandidate(): void {
  if (election.value.candidates.length >= ELECTION_MAX_CANDIDATES) return;
  update({
    candidates: [...election.value.candidates, ""],
    counts: [...election.value.counts, 0],
  });
}
function removeCandidate(index: number): void {
  if (election.value.candidates.length <= 1) return;
  const candidates = election.value.candidates.filter((_, at) => at !== index);
  update({
    candidates,
    counts: election.value.counts.filter((_, at) => at !== index),
    posts: Math.min(election.value.posts, candidates.length),
    maxChoices: Math.min(election.value.maxChoices, candidates.length),
  });
}
function setCount(index: number, value: number | null | undefined): void {
  const counts = [...election.value.counts];
  counts[index] = typeof value === "number" ? value : 0;
  update({ counts });
}

const outcome = computed(() =>
  computeElectionOutcome(
    election.value,
    {
      blank: props.secret ? blank.value : 0,
      invalid: props.secret ? invalid.value : 0,
      present: props.headcount?.present ?? null,
    },
    props.settings,
  ),
);
function names(indexes: number[]): string {
  return indexes
    .map((index) => election.value.candidates[index]?.trim() || "?")
    .join(", ");
}
const preview = computed(() => {
  const counted =
    election.value.counts.some((value) => value > 0) || blank.value > 0;
  if (!counted) return null;
  const result = outcome.value;
  if (result.inconsistent) return t("session.election.inconsistent");
  const parts: string[] = [];
  if (result.elected.length > 0) {
    parts.push(
      t(
        "session.election.elected",
        { names: names(result.elected) },
        result.elected.length,
      ),
    );
  }
  if (result.tie) parts.push(t("session.election.tie"));
  if (result.leftToMesa) {
    parts.push(
      t("session.election.leftToMesa", { threshold: result.threshold ?? 0 }),
    );
  }
  if (result.runoff) {
    parts.push(
      t("session.election.runoff", {
        names: names(result.runoff),
        threshold: result.threshold ?? 0,
      }),
    );
  }
  if (parts.length === 0) parts.push(t("session.election.nobody"));
  return parts.join(" · ");
});
// The count on screen ----------------------------------------------------------

const session = useOptionalSessionConsole();
/** The form belongs to the console of an open session: it can project. */
const projectionOffered = computed(() => Boolean(session?.inSession.value));
/** Counted tile by tile, which the projection follows. */
const liveCount = computed(() => projectionOffered.value && projected.value);
/** The votes are typed in. */
const typedCounts = computed(() => !liveCount.value);
/** A tile of the live count: a candidate, the ballots, blank or invalid. */
type TileKey = number | "ballots" | "blank" | "invalid";
const tiles = computed(() => [
  ...election.value.candidates.map((name, index) => ({
    key: index as TileKey,
    label: name.trim() || t("session.election.candidate", { n: index + 1 }),
    count: election.value.counts[index] ?? 0,
  })),
  // A ballot that may mark several: the Mesa counts the ballots too.
  ...(election.value.maxChoices > 1
    ? [
        {
          key: "ballots" as TileKey,
          label: t("session.election.ballots"),
          count: election.value.ballots,
        },
      ]
    : []),
  // Blank and invalid ballots only in a secret vote.
  ...(props.secret
    ? [
        {
          key: "blank" as TileKey,
          label: t("amendment.vote.blank"),
          count: blank.value,
        },
        {
          key: "invalid" as TileKey,
          label: t("amendment.vote.invalid"),
          count: invalid.value,
        },
      ]
    : []),
]);
/**
 * The last vote added or taken back, said once to screen readers with whose
 * it is («María García: 5, uno más»), never a bare count (E-123).
 */
const spoken = ref("");
function changeVote(key: TileKey, step: 1 | -1): void {
  const tile = tiles.value.find((entry) => entry.key === key);
  if (!tile) return;
  // Worked out here: the models only come back once the parent renders.
  const next = Math.max(0, tile.count + step);
  if (key === "blank") blank.value = next;
  else if (key === "invalid") invalid.value = next;
  else if (key === "ballots") update({ ballots: next });
  else setCount(key, next);
  spoken.value = t(
    step === 1 ? "session.election.countUp" : "session.election.countDown",
    { name: tile.label, count: next },
  );
}
/** The votes added, in order, so «Deshacer el último» takes the last back. */
const history = ref<TileKey[]>([]);
watch(liveCount, () => {
  history.value = [];
  spoken.value = "";
});
function addVote(key: TileKey): void {
  changeVote(key, 1);
  history.value = [...history.value, key];
}
function removeVote(key: TileKey): void {
  const tile = tiles.value.find((entry) => entry.key === key);
  if (!tile || tile.count === 0) return;
  changeVote(key, -1);
  const index = history.value.lastIndexOf(key);
  if (index !== -1) {
    history.value = history.value.filter((_, at) => at !== index);
  }
}
function undoVote(): void {
  const key = history.value.at(-1);
  if (key === undefined) return;
  history.value = history.value.slice(0, -1);
  changeVote(key, -1);
}

const { enabled: shortcutsEnabled } = useSingleKeyShortcuts();
const shortcutsOn = computed(() => liveCount.value && shortcutsEnabled.value);
/** The tiles a key reaches: the first nine (keys 1 to 9). */
const KEYED_TILES = 9;
/** Keys 1 to 9 add a vote, except in a field (WCAG 2.1.4: they can be off). */
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (!shortcutsOn.value || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable='true']")) {
    return;
  }
  if (!/^[1-9]$/.test(event.key)) return;
  const tile = tiles.value[Number(event.key) - 1];
  if (!tile) return;
  event.preventDefault();
  addVote(tile.key);
});
/** The last key that reaches a tile, for the hint. */
const lastKey = computed(() => Math.min(tiles.value.length, KEYED_TILES));

/** What the projection shows: null while the switch is off. */
const announcement = computed(() =>
  sessionElectionTally(
    election.value,
    {
      method: props.method,
      blank: props.secret ? blank.value : 0,
      invalid: props.secret ? invalid.value : 0,
    },
    {
      counting: projectionOffered.value,
      projected: projected.value,
      announce: props.announce,
      present: props.headcount?.present ?? null,
    },
  ),
);
let tallyShown = false;
watch(
  announcement,
  (tally) => {
    if (!session) return;
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
// Memory only on the server: sent again while the form is open, but not
// while the console saves (sessionTallyRepeatDue), as VoteFields does.
let repeatSkipped = false;
useIntervalFn(() => {
  if (!session || !announcement.value) return;
  const busy = Object.values(session.busy.value).some(Boolean);
  if (!sessionTallyRepeatDue({ busy, skippedLast: repeatSkipped })) {
    repeatSkipped = true;
    return;
  }
  repeatSkipped = false;
  session.pushTally(announcement.value);
}, 15_000);
onBeforeUnmount(() => {
  if (tallyShown) session?.pushTally(null);
});
</script>

<template>
  <div class="space-y-4">
    <fieldset class="space-y-2">
      <legend class="text-highlighted mb-1 text-sm font-medium">
        {{ t("session.election.candidates") }}
      </legend>
      <div
        v-for="(candidate, index) in election.candidates"
        :key="index"
        class="flex items-end gap-2"
      >
        <UFormField
          :label="t('session.election.candidate', { n: index + 1 })"
          class="min-w-0 flex-1"
        >
          <UInput
            :model-value="candidate"
            :maxlength="ELECTION_CANDIDATE_MAX_LENGTH"
            class="w-full"
            @update:model-value="(value) => setCandidate(index, String(value))"
          />
        </UFormField>
        <UFormField
          v-if="typedCounts"
          :label="t('session.election.votes')"
          class="w-28"
        >
          <UInputNumber
            :model-value="election.counts[index] ?? 0"
            :min="0"
            :max="100000"
            class="w-full"
            @update:model-value="(value) => setCount(index, value)"
          />
        </UFormField>
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-x"
          :aria-label="t('session.election.remove', { n: index + 1 })"
          :disabled="election.candidates.length <= 1"
          @click="removeCandidate(index)"
        />
      </div>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-plus"
        :label="t('session.election.add')"
        @click="addCandidate"
      />
    </fieldset>

    <!-- On screen: one tile per candidate, then the ballots when one may
         mark several, and the blank and invalid ones in a secret vote. A
         name wraps, never cut: two may differ only at the end (E-123). -->
    <div v-if="liveCount" class="grid grid-cols-2 gap-2 sm:grid-cols-3">
      <div
        v-for="(tile, index) in tiles"
        :key="String(tile.key)"
        class="border-default flex min-w-0 flex-col items-center gap-2 rounded-lg border p-3"
      >
        <span
          class="text-muted w-full text-center text-sm font-medium break-words"
        >
          {{ tile.label }}
        </span>
        <span class="text-highlighted text-3xl font-bold tabular-nums">
          {{ tile.count }}
        </span>
        <div class="flex items-center gap-1">
          <UButton
            size="lg"
            icon="i-lucide-plus"
            :label="t('session.vote.addBallot')"
            :aria-label="t('session.vote.addBallotFor', { option: tile.label })"
            :aria-keyshortcuts="
              shortcutsOn && index < KEYED_TILES ? String(index + 1) : undefined
            "
            @click="addVote(tile.key)"
          />
          <UButton
            size="lg"
            color="neutral"
            variant="ghost"
            icon="i-lucide-minus"
            :aria-label="
              t('session.vote.removeBallotFor', { option: tile.label })
            "
            :disabled="tile.count === 0"
            @click="removeVote(tile.key)"
          />
        </div>
        <UKbd
          v-if="shortcutsOn && index < KEYED_TILES"
          :value="String(index + 1)"
        />
      </div>
    </div>
    <div v-if="liveCount" class="flex flex-wrap items-center gap-2">
      <!-- Mounted with the tiles, before the first vote, so it is heard. -->
      <p class="sr-only" aria-live="polite">{{ spoken }}</p>
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        icon="i-lucide-undo-2"
        :label="t('session.vote.undoBallot')"
        :disabled="history.length === 0"
        @click="undoVote"
      />
      <p class="text-muted text-xs">
        {{
          shortcutsOn
            ? t("session.election.liveCountHintKeys", { last: lastKey })
            : t("session.vote.liveCountHint")
        }}
      </p>
    </div>

    <!-- The rest of the count: blank and invalid ballots, or abstentions,
         the ballots that marked someone and the members present. -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <template v-if="secret && typedCounts">
        <UFormField :label="t('amendment.vote.blank')">
          <UInputNumber v-model="blank" :min="0" :max="100000" class="w-full" />
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
      <UFormField v-if="!secret" :label="t('amendment.vote.abstentions')">
        <UInputNumber
          v-model="abstentions"
          :min="0"
          :max="100000"
          class="w-full"
        />
      </UFormField>
      <UFormField
        v-if="election.maxChoices > 1 && typedCounts"
        :label="t('session.election.ballots')"
        :help="t('session.election.ballotsHelp')"
      >
        <UInputNumber
          :model-value="election.ballots"
          :min="0"
          :max="100000"
          class="w-full"
          @update:model-value="(value) => update({ ballots: value ?? 0 })"
        />
      </UFormField>
      <div class="border-default rounded-lg border px-3 py-2">
        <p class="text-muted text-xs">{{ t("session.vote.present") }}</p>
        <p class="text-highlighted text-lg font-semibold tabular-nums">
          {{ headcount?.present ?? "—" }}
        </p>
      </div>
    </div>

    <!-- How it is decided, below the count (user's decision of 2026-11-21). -->
    <div class="grid gap-3 sm:grid-cols-2">
      <UFormField
        :label="t('session.election.posts')"
        :help="t('session.election.postsHelp')"
      >
        <UInputNumber
          :model-value="election.posts"
          :min="1"
          :max="election.candidates.length"
          class="w-full"
          @update:model-value="
            (value) => update({ posts: Math.max(1, value ?? 1) })
          "
        />
      </UFormField>
      <UFormField
        :label="t('session.election.maxChoices')"
        :help="t('session.election.maxChoicesHelp')"
      >
        <UInputNumber
          :model-value="election.maxChoices"
          :min="1"
          :max="election.candidates.length"
          class="w-full"
          @update:model-value="
            (value) => update({ maxChoices: Math.max(1, value ?? 1) })
          "
        />
      </UFormField>
    </div>

    <URadioGroup
      :model-value="election.rule"
      :legend="t('session.election.rule')"
      :items="
        ELECTION_RULES.map((rule) => ({
          value: rule,
          label: t(`session.election.rules.${rule}`),
          description: t(`session.election.rules.${rule}Hint`),
        }))
      "
      variant="card"
      :ui="{ fieldset: 'grid gap-2 sm:grid-cols-2' }"
      @update:model-value="
        (value) => update({ rule: value as ElectionInput['rule'] })
      "
    />

    <p
      v-if="preview"
      class="text-sm font-medium"
      :class="
        outcome.inconsistent ||
        outcome.runoff ||
        outcome.tie ||
        outcome.leftToMesa
          ? 'text-warning'
          : 'text-success'
      "
      aria-live="polite"
    >
      {{ preview }}
    </p>
  </div>
</template>
