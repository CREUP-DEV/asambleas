<script setup lang="ts">
import type { HeadcountDto, VoteInput } from "~~/shared/types/api";
import {
  MAJORITIES,
  VOTE_METHODS,
  type AssemblySettings,
  type VoteMethod,
} from "~~/shared/constants/domain";
import { sessionVoteOutcome } from "~/composables/session/sessionModel";

/**
 * Vote entry used by every session dialog: method, counts, majority and
 * note, with a live preview of the result the server will compute
 * (`computeVoteOutcome` with the assembly settings), including the tie rule
 * and counts that exceed the members present. Assent, when offered, has no
 * counts: only the method and the note are shown.
 *
 * With majorities on the members present, `headcount` is the Mesa's latest
 * count (the caller fills `present` from it): the form says which count it
 * is and warns, without blocking, when there is none or it lacks quorum.
 * Left undefined (the caller does not load counts), it only says that an
 * empty field takes the latest count, as the server does.
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
  }>(),
  {
    methods: () => VOTE_METHODS.filter((method) => method !== "assent"),
    showMajority: true,
    showNote: true,
    headcount: undefined,
  },
);

const vote = defineModel<VoteInput>({ required: true });

const { t, locale } = useI18n();
const uid = useId();

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

type CountKey = "inFavor" | "against" | "abstentions" | "blank" | "invalid";
const COUNT_KEYS: CountKey[] = [
  "inFavor",
  "against",
  "abstentions",
  "blank",
  "invalid",
];

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
  vote.value = { ...vote.value, [key]: value };
}

const assent = computed(() => vote.value.method === "assent");
const outcome = computed(() => sessionVoteOutcome(vote.value, props.settings));
const cast = computed(
  () =>
    (vote.value.inFavor ?? 0) +
    (vote.value.against ?? 0) +
    (vote.value.abstentions ?? 0) +
    (vote.value.blank ?? 0) +
    (vote.value.invalid ?? 0),
);
const onPresent = computed(() => props.settings.denominator === "present");
/** What the form says about the base of majorities, under the counts. */
const presentNote = computed<string | null>(() => {
  if (!onPresent.value) return null;
  const headcount = props.headcount;
  if (headcount === undefined) return t("session.vote.presentFromHeadcount");
  if (headcount === null) return null;
  const time = formatTime(headcount.takenAt, { locale: locale.value });
  return vote.value.present === headcount.present
    ? t("session.vote.presentFromCount", { time })
    : t("session.vote.presentCorrected", {
        time,
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
      props.settings.denominator === "present" && vote.value.present != null
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

    <p v-if="assent" class="text-muted text-sm">
      {{ t("session.vote.assentNoCount") }}
    </p>

    <fieldset v-else class="space-y-3">
      <legend class="text-highlighted mb-2 text-sm font-medium">
        {{ t("session.vote.counts") }}
      </legend>
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <UFormField
          v-for="key in COUNT_KEYS"
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
        <UFormField
          :label="t('session.vote.present')"
          :hint="t('session.vote.optional')"
          :name="`${uid}-present`"
        >
          <UInputNumber
            :model-value="vote.present ?? undefined"
            :min="0"
            :max="100000"
            :placeholder="t('session.vote.presentPlaceholder')"
            class="w-full"
            @update:model-value="(value) => setCount('present', value)"
          />
        </UFormField>
      </div>
      <p v-if="presentNote" class="text-muted text-xs">
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
      v-if="!assent"
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
