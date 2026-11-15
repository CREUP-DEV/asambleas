<script setup lang="ts">
import { ASSEMBLY_TYPES } from "~~/shared/constants/assemblyTypes";
import { VOTE_METHODS, type VoteMethod } from "~~/shared/constants/domain";
import type {
  ItemVoteBody,
  ItemVoteResultDto,
  VoteDto,
  VoteInput,
  VoteUnanimityBody,
  VoteVoidBody,
} from "~~/shared/types/api";
import { latestItemVote } from "~~/shared/utils/controlSheet";
import { VOTE_QUESTION_MAX_LENGTH } from "~~/shared/utils/schemas/vote";
import {
  isSessionFinalVoteReady,
  sessionCleanVote,
  sessionEmptyVote,
  sessionErrorData,
  sessionVoteOutcome,
} from "~/composables/session/sessionModel";
import type { GeneralSheetRow, ItemVoteContext } from "./-model";

/**
 * «Votaciones del punto» in the row panel: the votes on the agenda item
 * itself (a ratification, an election), voided ones marked, and, for the
 * Mesa and those who edit the sheet (`canWrite`), recording one, voiding
 * one and marking an assent unanimous. The latest vote in force gives the
 * item's result. An item voted through its documents, or one where members
 * present documents (voted in their own sub-items), takes none: one quiet
 * line says so. Nothing is projected from here: only the Mesa's console
 * puts a vote on screen.
 *
 * Every write hands the vote it answered with to the page (`changed`),
 * which puts it in place and fetches the sheet again; a failed one hands
 * null, so the page fetches what is there now.
 */
const props = defineProps<{
  row: GeneralSheetRow;
  apiBase: string;
  canWrite: boolean;
  context: ItemVoteContext;
}>();
const emit = defineEmits<{ changed: [vote: VoteDto | null] }>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();
const headingId = useId();

const votes = computed(() => props.row.itemVotes);
const latest = computed(() => latestItemVote(votes.value));
const inForce = computed(
  () => votes.value.filter((vote) => vote.voidedAt === null).length,
);

/** Recording: convened or in session, never a draft or closed assembly. */
const canRecord = computed(
  () =>
    props.canWrite &&
    props.row.takesOwnVote &&
    (props.context.status === "convened" ||
      props.context.status === "in_session"),
);
/** Voiding and unanimity: until the assembly closes. */
const canChange = computed(
  () => props.canWrite && props.context.status !== "closed",
);

const itemLabel = computed(() =>
  numberedAgendaTitle(
    props.row.number,
    props.row.title,
    t("agenda.unlisted.inText"),
  ),
);

function questionOf(vote: VoteDto): string {
  return vote.question ?? t("controlSheet.itemVotes.fallbackQuestion");
}

function when(at: string): string {
  return formatMoment(at, { locale: locale.value }).text;
}

const busy = ref<string | null>(null);

// Recording -------------------------------------------------------------------

const recordOpen = ref(false);
const question = ref("");
const vote = ref<VoteInput>(sessionEmptyVote("simple"));
const unanimous = ref(false);

/** Assent, show of hands, registered and secret; the portal in AGETs. */
const methods = computed<VoteMethod[]>(() =>
  VOTE_METHODS.filter(
    (method) =>
      method !== "portal" || props.context.type === ASSEMBLY_TYPES.AGET,
  ),
);

const outcome = computed(() =>
  sessionVoteOutcome(
    vote.value,
    props.context.settings,
    props.context.headcount,
  ),
);
const ready = computed(
  () =>
    question.value.trim().length > 0 &&
    isSessionFinalVoteReady(vote.value, outcome.value),
);

function openRecord(): void {
  // A repeated round asks the same; a first one starts from the item. The
  // question goes to every reader of the sheet, and to the room once the
  // Mesa puts the vote on screen: an item whose title the public does not
  // read (whatever this reader reads) starts empty, never from an earlier
  // question, which may carry that title.
  const guarded =
    props.row.unlisted || props.row.publicTitleHidden || props.row.titleHidden;
  question.value = guarded ? "" : (latest.value?.question ?? props.row.title);
  vote.value = sessionEmptyVote("simple");
  unanimous.value = false;
  recordOpen.value = true;
}

async function record(): Promise<void> {
  if (!canRecord.value || !ready.value || busy.value) return;
  const assent = vote.value.method === "assent";
  const body: ItemVoteBody = {
    question: question.value.trim(),
    vote: {
      ...sessionCleanVote(vote.value),
      ...(assent && unanimous.value ? { unanimous: true } : {}),
    },
  };
  busy.value = "record";
  try {
    const result = await api.send<ItemVoteResultDto>(
      `${props.apiBase}/agenda/${encodeURIComponent(props.row.id)}/votes`,
      { body: { ...body } },
    );
    emit("changed", result.vote);
    recordOpen.value = false;
    toast.add({
      title: t("controlSheet.itemVotes.recorded"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    if (sessionErrorData(error)?.tie === true) {
      toast.add({
        id: `control-sheet-tie-${props.row.id}`,
        title: t("session.vote.tieTitle"),
        description: t("session.vote.tieRepeat"),
        color: "warning",
        icon: "i-lucide-scale",
      });
    } else {
      api.notifyError(error, "controlSheet.itemVotes.recordFailed");
      emit("changed", null);
    }
  } finally {
    busy.value = null;
  }
}

// Voiding ---------------------------------------------------------------------

const voiding = ref<VoteDto | null>(null);

/** Asks before voiding; nothing while another change is on its way. */
function askVoid(target: VoteDto): void {
  if (!canChange.value || busy.value) return;
  voiding.value = target;
}
const voidOpen = computed({
  get: () => voiding.value !== null,
  set: (value) => {
    if (!value) voiding.value = null;
  },
});

async function confirmVoid(): Promise<void> {
  const target = voiding.value;
  if (!target || !canChange.value || busy.value) return;
  busy.value = target.id;
  const body: VoteVoidBody = { updatedAt: target.updatedAt };
  try {
    const voided = await api.send<VoteDto>(
      `${props.apiBase}/votes/${encodeURIComponent(target.id)}`,
      { method: "DELETE", body: { ...body } },
    );
    emit("changed", voided);
    voiding.value = null;
    toast.add({
      title: t("controlSheet.itemVotes.voidedToast"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    api.notifyError(error, "controlSheet.itemVotes.voidFailed");
    voiding.value = null;
    emit("changed", null);
  } finally {
    busy.value = null;
  }
}

// Unanimity -------------------------------------------------------------------

/**
 * The unanimity on its way, by vote: the box shows it meanwhile and stays
 * enabled, so the focus stays on it (as Treated.vue); a second change
 * waits for the answer (`busy`).
 */
const unanimityPending = ref<{ id: string; value: boolean } | null>(null);

function unanimousOf(entry: VoteDto): boolean {
  const pending = unanimityPending.value;
  return pending?.id === entry.id ? pending.value : entry.unanimous;
}

async function setUnanimous(target: VoteDto, value: boolean): Promise<void> {
  if (!canChange.value || busy.value || target.unanimous === value) return;
  busy.value = target.id;
  unanimityPending.value = { id: target.id, value };
  const body: VoteUnanimityBody = {
    unanimous: value,
    updatedAt: target.updatedAt,
  };
  try {
    emit(
      "changed",
      await api.send<VoteDto>(
        `${props.apiBase}/votes/${encodeURIComponent(target.id)}/unanimity`,
        { method: "PATCH", body: { ...body } },
      ),
    );
  } catch (error) {
    api.notifyError(error, "controlSheet.itemVotes.unanimityFailed");
    emit("changed", null);
  } finally {
    busy.value = null;
    unanimityPending.value = null;
  }
}
</script>

<template>
  <section class="space-y-3" :aria-labelledby="headingId">
    <h3 :id="headingId" class="text-highlighted text-sm font-medium">
      {{ t("controlSheet.itemVotes.title") }}
    </h3>

    <p v-if="row.votedThroughDocuments" class="text-muted text-sm">
      {{ t("controlSheet.itemVotes.byDocuments") }}
    </p>
    <p v-else-if="!row.takesOwnVote" class="text-muted text-sm">
      {{ t("controlSheet.itemVotes.container") }}
    </p>

    <ol v-if="votes.length > 0" class="space-y-2">
      <li
        v-for="entry in votes"
        :key="entry.id"
        class="border-default space-y-2 rounded-md border p-3"
      >
        <ControlSheetVoteLine
          :vote="entry"
          :label="questionOf(entry)"
          :voided="entry.voidedAt !== null"
        />
        <p class="text-muted text-xs">
          <template v-if="entry.voidedAt">
            {{
              t("controlSheet.itemVotes.voidedAt", {
                when: when(entry.voidedAt),
              })
            }}
          </template>
          <template v-else>
            {{
              t("controlSheet.itemVotes.recordedAt", {
                when: when(entry.recordedAt),
              })
            }}
            <template
              v-if="
                inForce > 1 &&
                entry.id === latest?.id &&
                !row.votedThroughDocuments
              "
            >
              · {{ t("controlSheet.itemVotes.decides") }}
            </template>
          </template>
        </p>
        <div
          v-if="canChange && entry.voidedAt === null"
          class="flex flex-wrap items-center justify-between gap-2"
        >
          <!-- Enabled while a change saves, so the focus stays; a second
               activation waits for the answer (busy). -->
          <UCheckbox
            v-if="entry.method === 'assent' && entry.result === 'approved'"
            :model-value="unanimousOf(entry)"
            :label="t('controlSheet.itemVotes.unanimous')"
            :description="t('controlSheet.itemVotes.unanimousHint')"
            :aria-busy="busy === entry.id || undefined"
            @update:model-value="(value) => setUnanimous(entry, value === true)"
          />
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-ban"
            class="ms-auto"
            :label="t('controlSheet.itemVotes.void')"
            :aria-label="
              t('controlSheet.itemVotes.voidLabel', {
                question: questionOf(entry),
              })
            "
            :aria-busy="busy === entry.id || undefined"
            @click="askVoid(entry)"
          />
        </div>
      </li>
    </ol>
    <p v-else-if="row.takesOwnVote" class="text-muted text-sm">
      {{ t("controlSheet.itemVotes.empty") }}
    </p>

    <UButton
      v-if="canRecord"
      size="sm"
      color="neutral"
      variant="outline"
      icon="i-lucide-gavel"
      :label="t('controlSheet.itemVotes.record')"
      @click="openRecord"
    />
    <p
      v-else-if="canWrite && row.takesOwnVote && context.status === 'draft'"
      class="text-muted text-xs"
    >
      {{ t("controlSheet.itemVotes.draftAssembly") }}
    </p>
    <p
      v-else-if="canWrite && context.status === 'closed'"
      class="text-muted text-xs"
    >
      {{ t("controlSheet.itemVotes.closed") }}
    </p>

    <UModal
      v-model:open="recordOpen"
      :title="t('controlSheet.itemVotes.recordTitle')"
      :description="itemLabel"
      :ui="{ content: 'sm:max-w-xl' }"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField
            :label="t('controlSheet.itemVotes.question')"
            :help="t('controlSheet.itemVotes.questionHint')"
            required
          >
            <UTextarea
              v-model="question"
              :rows="2"
              autoresize
              :maxlength="VOTE_QUESTION_MAX_LENGTH"
              :placeholder="t('controlSheet.itemVotes.questionPlaceholder')"
              class="w-full"
            />
          </UFormField>
          <SessionVoteFields
            v-model="vote"
            :settings="context.settings"
            :methods="methods"
            :headcount="context.headcount"
            :assent-text="t('controlSheet.itemVotes.assentText')"
          />
          <UCheckbox
            v-if="vote.method === 'assent'"
            v-model="unanimous"
            :label="t('controlSheet.itemVotes.unanimous')"
            :description="t('controlSheet.itemVotes.unanimousHint')"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            @click="recordOpen = false"
          />
          <UButton
            icon="i-lucide-gavel"
            :label="t('session.vote.submit')"
            :loading="busy === 'record'"
            :disabled="!ready"
            @click="record"
          />
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="voidOpen"
      :title="t('controlSheet.itemVotes.voidTitle')"
      :description="t('controlSheet.itemVotes.voidDescription')"
    >
      <template #body>
        <ControlSheetVoteLine
          v-if="voiding"
          :vote="voiding"
          :label="questionOf(voiding)"
        />
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            @click="voiding = null"
          />
          <UButton
            color="error"
            icon="i-lucide-ban"
            :label="t('controlSheet.itemVotes.voidConfirm')"
            :loading="voiding !== null && busy === voiding.id"
            @click="confirmVoid"
          />
        </div>
      </template>
    </UModal>
  </section>
</template>
