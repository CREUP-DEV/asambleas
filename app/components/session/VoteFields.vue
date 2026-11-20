<script setup lang="ts">
import type {
  HeadcountDto,
  LiveTallyReveal,
  VoteInput,
} from "~~/shared/types/api";
import {
  MAJORITIES,
  VOTE_METHODS,
  type AssemblySettings,
  type VoteMethod,
} from "~~/shared/constants/domain";
import {
  sessionFillPresent,
  sessionVoteOutcome,
} from "~/composables/session/sessionModel";
import { useOptionalSessionConsole } from "~/composables/session/useSessionConsole";
import {
  sessionLiveTally,
  sessionPendingTallyVote,
  sessionRevealAllowed,
  type LiveTallyAnnounce,
} from "~/composables/session/liveTally";
import {
  ballotKeysOf,
  foreignBallotKeys,
  SECRET_BALLOT_KEYS,
  type BallotKey,
} from "~~/shared/utils/votes";

/**
 * Vote entry used by every session dialog: method, counts, majority and
 * note, with a live preview of the result the server will compute
 * (`computeVoteOutcome` with the assembly settings), including the tie rule
 * and counts that exceed the members present. Assent, when offered, has no
 * counts: only the method and the note are shown.
 *
 * With majorities on the members present, `headcount` is the Mesa's latest
 * count (the session dialogs open with `present` empty, so a count another
 * Mesa device takes while the form is open becomes the base): the form says
 * which count it
 * is, with its day when it is not today's (Europe/Madrid), and warns,
 * without blocking, when there is none, it lacks quorum or it is from
 * another day. An empty field counts on it, in the preview as on the server
 * (sessionFillPresent), so the field is not "optional" then.
 * Left undefined (the caller does not load counts), it only says that an
 * empty field takes the latest count, as the server does.
 *
 * Who votes is never typed here (user's decision of 2026-11-18): the
 * members present are the latest headcount's, shown read only (a vote that
 * already stores its own keeps it), and to change them the Mesa corrects
 * the count. What each voter may cast depends on the method (user's
 * decision of 2026-11-19): in favour, against or abstain by show of hands,
 * roll call or the portal; in favour, against, blank or invalid in a
 * secret vote. The members present who cast nothing are «no emitidos»,
 * worked out, not typed, whenever that base is known.
 *
 * In the session console, while the session is open, a secret vote asks
 * first how the room follows the count (user's decision of 2026-11-19):
 * «Al final, con el resultado» (the counts are typed as for any method) or
 * «En directo, papeleta a papeleta» (one tile per kind of ballot, +1 and
 * −1, the keys 1 to 4 and undo). Nothing is counted, and nothing goes on
 * screen, until the Mesa picks one; then the projection announces the vote
 * (what the dialog passes in `announce`, the method and, live, the running
 * count) through session.pushTally, again every 15 s while the form is open
 * (the server keeps it in memory only), until the form closes or leaves
 * the secret method. The control sheet and Validación have no console, so
 * they never offer it.
 */
const props = withDefaults(
  defineProps<{
    settings: Pick<AssemblySettings, "denominator" | "tieRule">;
    /** Methods offered. Assent is left out by default: it has no counts. */
    methods?: VoteMethod[];
    showMajority?: boolean;
    showNote?: boolean;
    /** The latest headcount; null when there is none yet. */
    headcount?: HeadcountDto | null;
    /**
     * What an assent vote means, shown instead of the counts. The default
     * speaks of a text («el texto queda aprobado»); a vote on something
     * else (an agenda item) says what it approves.
     */
    assentText?: string;
    /**
     * An assent may be recorded unanimous (an agenda item's vote, a
     * document's final vote): nobody objected when the Mesa asked for
     * unanimity. Otherwise it stays an assent.
     */
    unanimity?: boolean;
    /**
     * What is voted, for the projection's announcement of a secret vote
     * counted in the console (sessionLiveTally). Without it the screen
     * still announces a secret vote and its count, unnamed.
     */
    announce?: LiveTallyAnnounce | null;
  }>(),
  {
    methods: () => VOTE_METHODS.filter((method) => method !== "assent"),
    showMajority: true,
    showNote: true,
    headcount: undefined,
    assentText: undefined,
    unanimity: false,
    announce: null,
  },
);

const vote = defineModel<VoteInput>({ required: true });

const { t, locale } = useI18n();
const uid = useId();

const session = useOptionalSessionConsole();
/** The form belongs to the console of an open session: it can project. */
const consoleCounts = computed(() => Boolean(session?.inSession.value));
/** A secret vote counted in the console asks how the room follows it. */
const revealOffered = computed(
  () => vote.value.method === "secret" && consoleCounts.value,
);
/** How the room follows the count; none until the Mesa picks one. */
const reveal = ref<LiveTallyReveal | null>(null);

const methodItems = computed(() =>
  props.methods.map((method) => ({
    label: t(`session.enums.voteMethod.${method}`),
    value: method,
  })),
);
const majorityItems = computed(() =>
  MAJORITIES.map((majority) => ({
    label: t(`session.enums.majority.${majority}`),
    value: majority,
  })),
);

type CountKey = BallotKey | "notCast";
/** What a voter may cast under the vote's method. */
const ballotKeys = computed(() => ballotKeysOf(vote.value.method));

function setCount(key: CountKey | "present", value: number | null | undefined) {
  const next = { ...vote.value };
  if (key === "present") {
    next.present = typeof value === "number" ? value : null;
  } else {
    next[key] = typeof value === "number" ? value : 0;
  }
  vote.value = next;
}

function setField<K extends "method" | "majority" | "note">(
  key: K,
  value: VoteInput[K],
) {
  const next = { ...vote.value, [key]: value };
  // Another method drops the ballots it does not take (blank and invalid
  // outside a secret vote, abstentions in one). Leaving a secret vote forgets
  // how the room followed it: one that turns secret again starts with no
  // mode picked, so with no ballots (the watch on revealPending), and counts
  // typed under another method never reach the screen all at once.
  if (key === "method") {
    for (const foreign of foreignBallotKeys(next.method)) next[foreign] = 0;
    if (next.method !== "secret") reveal.value = null;
  }
  vote.value = next;
}

const assent = computed(() => vote.value.method === "assent");
/** An assent nobody objected to when unanimity was asked. */
const unanimous = computed({
  get: () => vote.value.unanimous === true,
  set: (value: boolean) => {
    vote.value = { ...vote.value, unanimous: value };
  },
});
/**
 * The vote as the server will count it: an empty "present" takes the latest
 * headcount's (sessionFillPresent, like the server's fillPresent).
 */
const counted = computed(() =>
  sessionFillPresent(vote.value, props.headcount, props.settings),
);
const outcome = computed(() =>
  sessionVoteOutcome(vote.value, props.settings, props.headcount),
);
const cast = computed(
  () =>
    (vote.value.inFavor ?? 0) +
    (vote.value.against ?? 0) +
    (vote.value.abstentions ?? 0) +
    (vote.value.blank ?? 0) +
    (vote.value.invalid ?? 0),
);
const onPresent = computed(() => props.settings.denominator === "present");

/**
 * Who votes: the vote's own figure when it stores one (a correction keeps
 * it), else the latest headcount's; null without either.
 */
const base = computed<number | null>(
  () => vote.value.present ?? props.headcount?.present ?? null,
);
const ballots = computed(() =>
  ballotKeys.value.reduce((sum, key) => sum + (vote.value[key] ?? 0), 0),
);
// The members present who cast nothing: «no emitidos».
watch(
  [base, ballots, assent],
  () => {
    if (assent.value || base.value === null) return;
    const value = Math.max(0, base.value - ballots.value);
    if (vote.value.notCast !== value) {
      vote.value = { ...vote.value, notCast: value };
    }
  },
  { immediate: true },
);

// A secret vote announced on screen --------------------------------------------

/**
 * «En directo» is off once ballots are entered «Al final» (they would reach
 * the screen before the result: sessionRevealAllowed); its hint says how
 * to count live instead.
 */
const revealItems = computed(() =>
  (["end", "live"] as const).map((value) => {
    const disabled = !sessionRevealAllowed(reveal.value, value, ballots.value);
    return {
      value,
      label: t(`session.vote.reveal.${value}`),
      description: t(
        disabled
          ? "session.vote.reveal.liveLocked"
          : `session.vote.reveal.${value}Hint`,
      ),
      disabled,
    };
  }),
);
function setReveal(value: LiveTallyReveal): void {
  if (!sessionRevealAllowed(reveal.value, value, ballots.value)) return;
  reveal.value = value;
}
/** The Mesa still has to say how the count is shown: nothing is counted. */
const revealPending = computed(() => revealOffered.value && !reveal.value);
// No hidden count can be recorded meanwhile, however the form got there: a
// form that mounts already secret (a dialog keeps its vote across a v-if),
// a vote that turns secret, or a session that opens with counts typed.
watch(
  revealPending,
  (pending) => {
    if (!pending) return;
    const next = sessionPendingTallyVote(vote.value);
    if (next !== vote.value) vote.value = next;
  },
  { immediate: true },
);
/** Counting ballot by ballot, which the projection follows. */
const liveCount = computed(
  () => revealOffered.value && reveal.value === "live",
);
const { enabled: shortcutsEnabled } = useSingleKeyShortcuts();
const shortcutsOn = computed(() => liveCount.value && shortcutsEnabled.value);
/** The ballots added, in order, so «Deshacer» takes the last one back. */
const history = ref<BallotKey[]>([]);
// The other mode has no tiles to undo on.
watch(reveal, () => {
  history.value = [];
});

function addBallot(key: BallotKey): void {
  setCount(key, (vote.value[key] ?? 0) + 1);
  history.value = [...history.value, key];
}
function removeBallot(key: BallotKey): void {
  const current = vote.value[key] ?? 0;
  if (current === 0) return;
  setCount(key, current - 1);
  const index = history.value.lastIndexOf(key);
  if (index !== -1) {
    history.value = history.value.filter((_, at) => at !== index);
  }
}
function undoBallot(): void {
  const key = history.value.at(-1);
  if (!key) return;
  history.value = history.value.slice(0, -1);
  setCount(key, Math.max(0, (vote.value[key] ?? 0) - 1));
}

/** Keys 1 to 4 add a ballot, except in a field (WCAG 2.1.4: they can be off). */
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (!shortcutsOn.value || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  const target = event.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable='true']")) {
    return;
  }
  const index = Number(event.key) - 1;
  const key = SECRET_BALLOT_KEYS[index];
  if (!key) return;
  event.preventDefault();
  addBallot(key);
});

/**
 * What the projection shows (sessionLiveTally): null while the method is
 * not secret or no mode is picked. A change of mode sends the new
 * announcement straight away, which replaces the previous one (null first
 * would let the last result flash in between).
 */
const announcement = computed(() =>
  sessionLiveTally(vote.value, {
    counting: consoleCounts.value,
    reveal: reveal.value,
    announce: props.announce,
    present: base.value,
  }),
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
// Memory only on the server (a restart forgets it, a projected result
// ends it): sent again while the form is open.
const TALLY_REPEAT_MS = 15_000;
useIntervalFn(() => {
  if (session && announcement.value) session.pushTally(announcement.value);
}, TALLY_REPEAT_MS);
onBeforeUnmount(() => {
  if (tallyShown) session?.pushTally(null);
});
const now = useAppNow();
/** When the latest count was taken, with its day when not today (Madrid). */
const taken = computed(() =>
  props.headcount
    ? formatMoment(props.headcount.takenAt, {
        locale: locale.value,
        now: now.value,
      })
    : null,
);
/** The count is the base of this vote: the field is empty or matches it. */
const fromCount = computed(
  () =>
    Boolean(props.headcount) &&
    (vote.value.present == null ||
      vote.value.present === props.headcount?.present),
);
/**
 * The base comes from a count taken another day: a discreet, non-blocking
 * line says so, since the room may have changed overnight.
 */
const otherDay = computed(
  () => onPresent.value && fromCount.value && taken.value?.today === false,
);
/** What the form says about the base of majorities, under the counts. */
const presentNote = computed<string | null>(() => {
  if (!onPresent.value) return null;
  const headcount = props.headcount;
  if (headcount === undefined) return t("session.vote.presentFromHeadcount");
  if (headcount === null || !taken.value) return null;
  const { text, today } = taken.value;
  if (fromCount.value) {
    return today
      ? t("session.vote.presentFromCount", { time: text })
      : t("session.vote.presentFromCountDay", { moment: text });
  }
  return today
    ? t("session.vote.presentCorrected", {
        time: text,
        present: headcount.present,
      })
    : t("session.vote.presentCorrectedDay", {
        moment: text,
        present: headcount.present,
      });
});
/** Warnings that never block: no headcount yet, or one without quorum. */
const headcountWarning = computed<string | null>(() => {
  if (!onPresent.value || props.headcount === undefined) return null;
  if (props.headcount === null) {
    return vote.value.present == null ? t("session.vote.noHeadcount") : null;
  }
  return props.headcount.quorum
    ? null
    : t("session.vote.headcountNoQuorum", {
        present: props.headcount.present,
        required: props.headcount.required,
      });
});

const resultColor = computed(() =>
  outcome.value.result === "approved"
    ? "success"
    : outcome.value.result === "rejected"
      ? "error"
      : "warning",
);
const thresholdText = computed(() =>
  (vote.value.majority ?? "simple") === "simple"
    ? t("session.vote.thresholdSimple")
    : t(
        "session.vote.threshold",
        { count: outcome.value.threshold },
        outcome.value.threshold,
      ),
);
const denominatorText = computed(() =>
  t("session.vote.denominator", {
    count: outcome.value.denominator,
    base:
      props.settings.denominator === "present" && counted.value.present != null
        ? t("session.vote.denominatorPresent")
        : t("session.vote.denominatorValid"),
  }),
);
</script>

<template>
  <div class="space-y-4">
    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField :label="t('session.vote.method')" :name="`${uid}-method`">
        <USelect
          :model-value="vote.method"
          :items="methodItems"
          class="w-full"
          @update:model-value="
            (value) => setField('method', value as VoteMethod)
          "
        />
      </UFormField>
      <UFormField
        v-if="showMajority && !assent"
        :label="t('session.vote.majority')"
        :name="`${uid}-majority`"
      >
        <USelect
          :model-value="vote.majority ?? 'simple'"
          :items="majorityItems"
          class="w-full"
          @update:model-value="
            (value) => setField('majority', value as VoteInput['majority'])
          "
        />
      </UFormField>
    </div>

    <!-- A secret vote in the console: how the room follows the count, to
         pick before counting. -->
    <div v-if="revealOffered" class="space-y-2">
      <URadioGroup
        :model-value="reveal ?? undefined"
        :legend="t('session.vote.reveal.label')"
        :items="revealItems"
        value-key="value"
        variant="card"
        :ui="{ fieldset: 'grid gap-2 sm:grid-cols-2' }"
        class="w-full"
        @update:model-value="(value) => setReveal(value as LiveTallyReveal)"
      />
      <p v-if="revealPending" class="text-muted text-sm">
        {{ t("session.vote.reveal.pending") }}
      </p>
      <p
        v-else-if="session && !session.inControl.value"
        class="text-muted text-xs"
      >
        {{ t("session.vote.reveal.notProjected") }}
      </p>
    </div>

    <template v-if="assent">
      <p class="text-muted text-sm">
        {{ assentText ?? t("session.vote.assentNoCount") }}
      </p>
      <UCheckbox
        v-if="unanimity"
        v-model="unanimous"
        :label="t('session.itemVote.unanimous')"
        :description="t('session.itemVote.unanimousHint')"
      />
    </template>

    <fieldset v-else-if="!revealPending" class="space-y-3">
      <legend class="text-highlighted mb-2 text-sm font-medium">
        {{ t("session.vote.counts") }}
      </legend>

      <!-- A secret vote counted live: one tile per ballot, the room sees
           the count as it goes. -->
      <div v-if="liveCount" class="space-y-2">
        <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div
            v-for="(key, index) in SECRET_BALLOT_KEYS"
            :key="key"
            class="border-default flex flex-col items-center gap-2 rounded-lg border p-3"
          >
            <span class="text-muted text-sm font-medium">
              {{ t(`session.vote.${key}`) }}
            </span>
            <span
              class="text-highlighted text-3xl font-bold tabular-nums"
              aria-live="polite"
            >
              {{ vote[key] ?? 0 }}
            </span>
            <div class="flex items-center gap-1">
              <UButton
                size="lg"
                icon="i-lucide-plus"
                :label="t('session.vote.addBallot')"
                :aria-label="
                  t('session.vote.addBallotFor', {
                    option: t(`session.vote.${key}`),
                  })
                "
                :aria-keyshortcuts="shortcutsOn ? String(index + 1) : undefined"
                @click="addBallot(key)"
              />
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-minus"
                :aria-label="
                  t('session.vote.removeBallotFor', {
                    option: t(`session.vote.${key}`),
                  })
                "
                :disabled="(vote[key] ?? 0) === 0"
                @click="removeBallot(key)"
              />
            </div>
            <UKbd v-if="shortcutsOn" :value="String(index + 1)" />
          </div>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-undo-2"
            :label="t('session.vote.undoBallot')"
            :disabled="history.length === 0"
            @click="undoBallot"
          />
          <p class="text-muted text-xs">
            {{
              shortcutsOn
                ? t("session.vote.liveCountHintKeys")
                : t("session.vote.liveCountHint")
            }}
          </p>
        </div>
      </div>

      <div
        v-else
        :class="[
          'grid grid-cols-2 gap-3',
          ballotKeys.length === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-4',
        ]"
      >
        <UFormField
          v-for="key in ballotKeys"
          :key="key"
          :label="t(`session.vote.${key}`)"
          :name="`${uid}-${key}`"
        >
          <UInputNumber
            :model-value="vote[key] ?? 0"
            :min="0"
            :max="100000"
            class="w-full"
            @update:model-value="(value) => setCount(key, value)"
          />
        </UFormField>
      </div>

      <!-- Who votes comes from the latest headcount, never typed here; the
           members present who cast nothing are «no emitidos». -->
      <dl class="grid grid-cols-2 gap-3 text-sm">
        <div class="border-default rounded-lg border px-3 py-2">
          <dt class="text-muted text-xs">{{ t("session.vote.present") }}</dt>
          <dd class="text-highlighted text-lg font-semibold tabular-nums">
            {{ base ?? "—" }}
          </dd>
        </div>
        <div
          v-if="base !== null"
          class="border-default rounded-lg border px-3 py-2"
        >
          <dt class="text-muted text-xs">
            {{ t("session.vote.notCastAuto") }}
          </dt>
          <dd class="text-highlighted text-lg font-semibold tabular-nums">
            {{ vote.notCast ?? 0 }}
          </dd>
        </div>
        <UFormField
          v-else
          :label="t('session.vote.notCast')"
          :name="`${uid}-not-cast`"
        >
          <UInputNumber
            :model-value="vote.notCast ?? 0"
            :min="0"
            :max="100000"
            class="w-full"
            @update:model-value="(value) => setCount('notCast', value)"
          />
        </UFormField>
      </dl>
      <p class="text-muted text-xs">{{ t("session.vote.presentFixed") }}</p>
      <!-- A count from another day: the same line, with a warning icon and
           a hint to count again. It never blocks the vote. -->
      <p
        v-if="presentNote && otherDay"
        class="text-default flex items-start gap-1.5 text-xs"
      >
        <UIcon
          name="i-lucide-calendar-clock"
          class="text-warning mt-px size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span>
          {{ presentNote }} {{ t("session.vote.headcountOtherDay") }}
        </span>
      </p>
      <p v-else-if="presentNote" class="text-muted text-xs">
        {{ presentNote }}
      </p>
      <UAlert
        v-if="headcountWarning"
        color="warning"
        variant="subtle"
        icon="i-lucide-users-round"
        :description="headcountWarning"
      />
    </fieldset>

    <UFormField
      v-if="showNote"
      :label="t('session.vote.note')"
      :name="`${uid}-note`"
    >
      <UTextarea
        :model-value="vote.note ?? ''"
        :rows="2"
        autoresize
        :maxlength="2000"
        class="w-full"
        @update:model-value="(value) => setField('note', String(value ?? ''))"
      />
    </UFormField>

    <div
      v-if="!assent && !revealPending"
      class="border-default bg-elevated/40 space-y-2 rounded-lg border p-3"
      aria-live="polite"
      aria-atomic="true"
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="text-muted text-sm font-medium">
          {{ t("session.vote.previewTitle") }}
        </span>
        <UBadge
          :color="resultColor"
          variant="solid"
          size="lg"
          :label="t(`session.vote.result.${outcome.result}`)"
        />
      </div>
      <p class="text-default text-sm">
        {{ thresholdText }} ·
        {{ t("session.vote.cast", { count: cast }, cast) }}
      </p>
      <p class="text-muted text-xs">{{ denominatorText }}</p>
      <UAlert
        v-if="outcome.result === 'tie'"
        color="warning"
        variant="subtle"
        icon="i-lucide-scale"
        :title="t('session.vote.tieTitle')"
        :description="t('session.vote.tieRepeat')"
      />
      <p
        v-else-if="
          (vote.majority ?? 'simple') === 'simple' &&
          (vote.inFavor ?? 0) === (vote.against ?? 0)
        "
        class="text-muted text-xs"
      >
        {{ t("session.vote.tieRejected") }}
      </p>
      <UAlert
        v-if="outcome.inconsistent"
        color="error"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="t('session.vote.inconsistentTitle')"
        :description="t('session.vote.inconsistent')"
      />
    </div>
  </div>
</template>
