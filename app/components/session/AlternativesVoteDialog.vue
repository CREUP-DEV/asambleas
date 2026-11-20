<script setup lang="ts">
import type { VoteMethod } from "~~/shared/constants/domain";
import { amendmentVoteMajority } from "~~/shared/constants/domain";
import {
  ALTERNATIVES_OPTION_COUNT,
  alternativeLetter,
  computeAlternativesOutcome,
  type AlternativesTieResolution,
} from "~~/shared/utils/alternativesVote";
import { amendmentsMeet } from "~~/shared/utils/content/passages";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

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
/** The server found no winner (the members present may differ). */
const serverUndecided = ref<"tie" | "short" | null>(null);
const busy = ref(false);

watch(open, (value) => {
  if (!value) return;
  const ids = session.alternativesDialog.ids;
  const options = session.alternativesDialog.options;
  choice.value = Object.fromEntries(
    ids.map((id) => [
      id,
      options ? options.findIndex((option) => option.includes(id)) : null,
    ]),
  );
  method.value = "show_of_hands";
  resetCounts();
  note.value = "";
});

function resetCounts(): void {
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

const onScreen = computed(() => {
  const live = session.roomAlternatives.value;
  if (!live || live.length !== options.value.length) return false;
  return live.every(
    (ids, index) =>
      ids.length === options.value[index]!.length &&
      ids.every((id) => options.value[index]!.includes(id)),
  );
});

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
    return t("session.alternatives.winsPreview", {
      letter: alternativeLetter(outcome.value.winner),
    });
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

function amendmentLine(id: string): string {
  const amendment = session.byId.value.get(id);
  const authors =
    amendment?.authors.map((author) => author.acronym).join(", ") ?? "";
  return authors ? `${session.label(id)} · ${authors}` : session.label(id);
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('session.alternatives.title')"
    :description="t('session.alternatives.description')"
    :ui="{ content: 'sm:max-w-3xl' }"
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
        </section>

        <!-- 2. The votes -->
        <section class="space-y-3">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.alternatives.countsTitle") }}
          </h3>
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
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
