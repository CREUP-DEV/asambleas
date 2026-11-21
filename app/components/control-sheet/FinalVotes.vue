<script setup lang="ts">
import type {
  DocumentDto,
  FinalVoteAnnulBody,
  FinalVoteBody,
  VoteInput,
} from "~~/shared/types/api";
import {
  sessionCleanVote,
  sessionErrorData,
  sessionErrorIds,
} from "~/composables/session/sessionModel";
import type { ItemVoteContext, SheetRowDocument } from "./-model";

/**
 * The final votes of an item's documents, recorded from the control sheet
 * (user's decision of 2026-11-19) while the Mesa may have moved the
 * projection on: the same endpoint as the console (POST .../final-vote)
 * with `project: false`, so nothing goes on screen. A document whose
 * amendments are not all decided says how many are left; one with its
 * final vote shows it and can have it annulled (a mistake, until the
 * assembly closes). For the Mesa and whoever holds assembly:vote_result.
 *
 * The sheet knows only the undecided amendments; the console knows the
 * rest of what holds a final vote back (approved amendments that collide,
 * passages the Mesa still has to word). The server refuses those with 409
 * and what is missing (`undecided`, `conflicts`, `pendingPassages`), and
 * the sheet says which, never the generic "someone changed this" of a
 * stale write, which only reloading would seem to fix.
 */
const props = defineProps<{
  documents: readonly SheetRowDocument[];
  apiBase: string;
  context: ItemVoteContext;
}>();
const emit = defineEmits<{ changed: [] }>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();

/** The documents that are voted, past draft. */
const voted = computed(() =>
  props.documents.filter(
    (document) => document.voted && document.status === "published",
  ),
);
const inSession = computed(() => props.context.status === "in_session");
const canAnnul = computed(() => props.context.status !== "closed");

const busy = ref<string | null>(null);
const documentUrl = (id: string) =>
  `${props.apiBase}/documents/${encodeURIComponent(id)}`;

// Recording -------------------------------------------------------------------

/** What holds the final vote back, from the server's 409; null otherwise. */
function finalVoteBlocker(error: unknown): string | null {
  if (api.errorStatus(error) !== 409) return null;
  const passages = sessionErrorData(error)?.pendingPassages;
  if (Array.isArray(passages) && passages.length > 0) {
    return `${t(
      "session.preview.pendingWordings",
      { count: passages.length },
      passages.length,
    )} ${t("controlSheet.results.finalFromConsole")}`;
  }
  const conflicts = sessionErrorData(error)?.conflicts;
  if (Array.isArray(conflicts) && conflicts.length > 0) {
    return `${t(
      "session.preview.conflictsTitle",
      { count: conflicts.length },
      conflicts.length,
    )}. ${t("controlSheet.results.finalFromConsole")}`;
  }
  const undecided = sessionErrorIds(error, "undecided");
  if (undecided.length > 0) {
    return `${t(
      "session.finalVote.undecided",
      { count: undecided.length },
      undecided.length,
    )}.`;
  }
  return null;
}

const recording = ref<SheetRowDocument | null>(null);
const recordOpen = computed({
  get: () => recording.value !== null,
  set: (value) => {
    if (!value) recording.value = null;
  },
});

/** Passages still to word in the server's 409 (none for any other answer). */
function pendingPassageCount(error: unknown): number {
  if (api.errorStatus(error) !== 409) return 0;
  const passages = sessionErrorData(error)?.pendingPassages;
  return Array.isArray(passages) ? passages.length : 0;
}

/**
 * The passages a refused final vote left to word, for the document whose
 * form refused it: the form then offers to vote leaving them pending
 * conciliation (user's decisions of 2026-11-21), an explicit choice sent
 * with the form's own button and its current counts. Opening another
 * document's form, or closing this one, forgets it.
 */
const pending = ref<{ id: string; count: number } | null>(null);
const leavePending = ref(false);
watch(
  () => recording.value?.id,
  () => {
    pending.value = null;
    leavePending.value = false;
  },
);

async function submit(vote: VoteInput): Promise<void> {
  const target = recording.value;
  if (!target || busy.value) return;
  busy.value = target.id;
  const allowPending = pending.value?.id === target.id && leavePending.value;
  const body: FinalVoteBody = {
    vote: sessionCleanVote(vote),
    project: false,
    ...(allowPending ? { allowPendingPassages: true } : {}),
  };
  try {
    const result = await api.send<DocumentDto>(
      `${documentUrl(target.id)}/final-vote`,
      { body },
    );
    if (recording.value?.id === target.id) recording.value = null;
    toast.add({
      title: t("controlSheet.results.finalRecorded", { title: target.title }),
      description:
        result.finalVote?.result !== "approved"
          ? t("controlSheet.results.voteRejected")
          : result.pendingConciliation > 0
            ? t("document.pendingConciliation.status")
            : t("controlSheet.results.voteApproved"),
      color: "success",
      icon: "i-lucide-check",
    });
    emit("changed");
  } catch (error) {
    const blocker = finalVoteBlocker(error);
    const pendingCount = pendingPassageCount(error);
    if (pendingCount > 0 && recording.value?.id === target.id) {
      // The form stays open and says so: the Mesa may vote leaving them
      // pending conciliation, or word them from the console first.
      pending.value = { id: target.id, count: pendingCount };
      leavePending.value = false;
    } else if (sessionErrorData(error)?.tie === true) {
      toast.add({
        title: t("session.vote.tieTitle"),
        description: t("session.vote.tieRepeat"),
        color: "warning",
        icon: "i-lucide-scale",
      });
    } else if (blocker) {
      // Closes the refused form only, never another document's opened since.
      if (recording.value?.id === target.id) recording.value = null;
      toast.add({
        title: t("controlSheet.results.finalBlocked"),
        description: blocker,
        color: "warning",
        icon: "i-lucide-pen-line",
      });
      emit("changed");
    } else {
      api.notifyError(error, "controlSheet.results.failed");
      emit("changed");
    }
  } finally {
    busy.value = null;
  }
}

// Annulling -------------------------------------------------------------------

const annulling = ref<SheetRowDocument | null>(null);
const annulOpen = computed({
  get: () => annulling.value !== null,
  set: (value) => {
    if (!value) annulling.value = null;
  },
});

async function annul(): Promise<void> {
  const target = annulling.value;
  if (!target || busy.value) return;
  busy.value = target.id;
  const body: FinalVoteAnnulBody = { updatedAt: target.updatedAt, note: null };
  try {
    await api.send<DocumentDto>(`${documentUrl(target.id)}/final-vote`, {
      method: "DELETE",
      body,
    });
    annulling.value = null;
    toast.add({
      title: t("controlSheet.results.finalAnnulled", { title: target.title }),
      color: "success",
      icon: "i-lucide-check",
    });
    emit("changed");
  } catch (error) {
    api.notifyError(error, "controlSheet.results.failed");
    emit("changed");
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <section
    v-if="voted.length > 0"
    class="space-y-2"
    aria-labelledby="control-sheet-final-votes"
  >
    <h3
      id="control-sheet-final-votes"
      class="text-highlighted text-sm font-medium"
    >
      {{ t("controlSheet.results.finalTitle") }}
    </h3>
    <ul class="divide-default divide-y">
      <li
        v-for="document in voted"
        :key="document.id"
        class="space-y-1.5 py-2 first:pt-0 last:pb-0"
      >
        <p class="text-default text-sm font-medium">{{ document.title }}</p>
        <template v-if="document.finalVote">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <ControlSheetVoteLine :vote="document.finalVote" />
            <UButton
              v-if="canAnnul"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-lucide-ban"
              :label="t('controlSheet.results.annul')"
              :disabled="busy !== null"
              @click="annulling = document"
            />
          </div>
        </template>
        <p v-else-if="document.undecided > 0" class="text-muted text-sm">
          {{
            t(
              "controlSheet.results.undecidedLeft",
              { count: document.undecided },
              document.undecided,
            )
          }}
        </p>
        <UButton
          v-else-if="inSession"
          size="sm"
          icon="i-lucide-gavel"
          :label="t('controlSheet.results.finalVote')"
          :disabled="busy !== null"
          @click="recording = document"
        />
        <p v-else class="text-muted text-sm">
          {{ t("controlSheet.results.notInSession") }}
        </p>
      </li>
    </ul>

    <ControlSheetVoteDialog
      v-model:open="recordOpen"
      :title="t('controlSheet.results.finalVote')"
      :description="recording?.title"
      :majority="recording?.majority ?? 'simple'"
      :context="context"
      :busy="busy !== null"
      with-assent
      @submit="submit"
    >
      <UAlert
        v-if="pending && pending.id === recording?.id"
        color="warning"
        variant="subtle"
        icon="i-lucide-pen-line"
        :title="t('controlSheet.results.finalBlocked')"
      >
        <template #description>
          <p>
            {{
              t(
                "session.preview.pendingWordings",
                { count: pending.count },
                pending.count,
              )
            }}
          </p>
          <UCheckbox
            v-model="leavePending"
            class="mt-3"
            :label="
              t(
                'session.finalVote.leavePending',
                { count: pending.count },
                pending.count,
              )
            "
            :description="t('session.finalVote.leavePendingHint')"
          />
        </template>
      </UAlert>
    </ControlSheetVoteDialog>

    <UModal
      v-model:open="annulOpen"
      :title="t('controlSheet.results.annulTitle')"
      :description="annulling?.title"
    >
      <template #body>
        <p class="text-default text-sm">
          {{ t("controlSheet.results.annulHint") }}
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            @click="annulling = null"
          />
          <UButton
            color="error"
            icon="i-lucide-ban"
            :label="t('controlSheet.results.annul')"
            :loading="busy !== null"
            @click="annul"
          />
        </div>
      </template>
    </UModal>
  </section>
</template>
