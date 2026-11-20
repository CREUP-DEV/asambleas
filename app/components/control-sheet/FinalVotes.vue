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

async function submit(vote: VoteInput): Promise<void> {
  const target = recording.value;
  if (!target || busy.value) return;
  busy.value = target.id;
  const body: FinalVoteBody = { vote: sessionCleanVote(vote), project: false };
  try {
    const result = await api.send<DocumentDto>(
      `${documentUrl(target.id)}/final-vote`,
      { body },
    );
    recording.value = null;
    toast.add({
      title: t("controlSheet.results.finalRecorded", { title: target.title }),
      description:
        result.finalVote?.result === "approved"
          ? t("controlSheet.results.voteApproved")
          : t("controlSheet.results.voteRejected"),
      color: "success",
      icon: "i-lucide-check",
    });
    emit("changed");
  } catch (error) {
    const blocker = finalVoteBlocker(error);
    if (sessionErrorData(error)?.tie === true) {
      toast.add({
        title: t("session.vote.tieTitle"),
        description: t("session.vote.tieRepeat"),
        color: "warning",
        icon: "i-lucide-scale",
      });
    } else if (blocker) {
      recording.value = null;
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
    />

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
