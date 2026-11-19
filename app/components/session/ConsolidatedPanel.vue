<script setup lang="ts">
import { voteTextKey } from "~~/shared/utils/votes";
import type { ConsolidationConflict } from "~~/shared/types/content";
import { liveAssentKey } from "~/components/live-view/-model";
import { useFinalVoteReasonText } from "~/composables/session/useFinalVoteReasonText";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { assemblyPath } from "~/components/shell/Navigation.vue";

/**
 * The text as it stands: the base with every approved amendment applied in
 * approval order, each fragment linked to its amendment (provenance), the
 * conflicts that stop amendments from applying together, and the final vote.
 * A wrongly recorded final vote can be annulled while the assembly is open:
 * the vote stays in the record and the text awaits its final vote again.
 * An approved one by assent can be marked unanimous then, or no longer.
 *
 * While the final vote is blocked, each reason says who has to act: the
 * Mesa decides the amendments still open; the assembly decides whether to
 * treat the late ones; the main authors accept (or not) the transactionals
 * over their amendments; the Secretaría validates (or sends back) those it
 * has not checked yet.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();
const localePath = useLocalePath();

const document = computed(() => session.document.value);
const preview = computed(() => session.preview.value);
const structured = computed(() => document.value?.format === "structured");
const finalVote = computed(() => document.value?.finalVote ?? null);
/** The Mesa words passages until the final vote fixes the text. */
const canWord = computed(
  () => Boolean(document.value?.can.moderate) && !finalVote.value,
);
const PASSAGE_COLORS = {
  pending: "warning",
  automatic: "neutral",
  worded: "success",
} as const;
const blockers = computed(() => session.finalVoteBlockers.value);
/** Whoever can validate the waiting amendments gets a way to do it. */
const validationPath = computed(() => {
  const assembly = session.assembly.value;
  if (!assembly) return null;
  const canValidate = blockers.value.awaitingValidation.some(
    (id) => session.byId.value.get(id)?.can.validate,
  );
  return canValidate
    ? localePath(assemblyPath(assembly.slug, "validation"))
    : null;
});

const canAnnul = computed(
  () =>
    Boolean(finalVote.value) &&
    Boolean(document.value?.can.moderate) &&
    session.assembly.value?.status !== "closed",
);

/**
 * How the final vote went: «Por unanimidad» for a unanimous assent, else
 * «Por asentimiento» or the counts.
 */
const finalVoteMethodText = computed(() => {
  const vote = finalVote.value;
  if (!vote) return "";
  const assentKey = liveAssentKey(vote);
  return assentKey
    ? t(assentKey)
    : t(voteTextKey("session.card.voteCounts", vote.method), {
        inFavor: vote.inFavor,
        against: vote.against,
        abstentions: vote.abstentions,
        blank: vote.blank,
      });
});

/**
 * An approved final vote by assent can be marked unanimous (nobody objected
 * when the Mesa asked), or no longer, while the assembly is open: the same
 * rule the server applies to the vote the document points at.
 */
const canChangeUnanimity = computed(
  () =>
    canAnnul.value &&
    finalVote.value?.method === "assent" &&
    finalVote.value.result === "approved" &&
    !finalVote.value.voidedAt,
);
const unanimityBusy = computed(() =>
  finalVote.value
    ? Boolean(session.busy.value[`vote-${finalVote.value.id}`])
    : false,
);

/**
 * The button stays enabled while saving, so the focus stays on it (its
 * label turns over when the change lands); a second press meanwhile is
 * ignored by the console.
 */
function toggleUnanimity(): void {
  const vote = finalVote.value;
  if (vote) void session.setVoteUnanimity(vote, !vote.unanimous);
}

// Kept in the console so anyDialogOpen pauses the page shortcuts while the
// modal is open.
const annulOpen = computed({
  get: () => session.finalVoteAnnulDialog.open,
  set: (value: boolean) => {
    session.finalVoteAnnulDialog.open = value;
  },
});
const annulNote = ref("");
watch(annulOpen, (isOpen) => {
  if (isOpen) annulNote.value = "";
});
// Another Mesa member may annul it first (live update): nothing left to
// annul. The console closes the modal when the live document changes.
watch(canAnnul, (can) => {
  if (!can) annulOpen.value = false;
});

async function annul(): Promise<void> {
  const ok = await session.annulFinalVote(annulNote.value);
  if (ok) annulOpen.value = false;
}

const loading = computed(
  () => !document.value && session.documentStatus.value === "pending",
);

function conflictText(conflict: ConsolidationConflict): string {
  const code = session.label(conflict.amendmentId);
  return conflict.conflictsWith.length > 0
    ? t("session.preview.conflictWith", {
        code,
        others: conflict.conflictsWith.map(session.label).join(", "),
      })
    : t("session.preview.conflictInvalid", { code });
}

function focusAmendment(id: string): void {
  session.focusedId.value = id;
  if (!import.meta.client) return;
  const element = window.document.getElementById(`session-amendment-${id}`);
  element?.scrollIntoView({ block: "center" });
  element?.focus({ preventScroll: true });
}

/** Why the final vote cannot be opened yet: one sentence per reason. */
const reasonText = useFinalVoteReasonText();
const finalBlockedReasons = computed<string[]>(() =>
  session.finalVoteReasons.value.map(reasonText),
);
const finalBlocked = computed(() => finalBlockedReasons.value.length > 0);
/** The reasons describe the disabled button to screen readers. */
const reasonsId = useId();
const awaitingValidation = computed(
  () => blockers.value.awaitingValidation.length,
);
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading" class="space-y-3" role="status">
      <span class="sr-only">{{ t("workspace.loading") }}</span>
      <USkeleton aria-hidden="true" class="h-6 w-1/2" />
      <USkeleton
        v-for="n in 5"
        :key="n"
        aria-hidden="true"
        class="h-16 w-full"
      />
    </div>

    <CommonEmptyState
      v-else-if="!document"
      icon="i-lucide-file-text"
      size="sm"
      :title="t('session.preview.noDocument')"
    />

    <template v-else>
      <section class="space-y-2" :aria-label="t('session.finalVote.title')">
        <div
          v-if="finalVote"
          class="rounded-lg border p-3"
          :class="
            finalVote.result === 'approved'
              ? 'border-success/50 bg-success/10'
              : 'border-error/50 bg-error/10'
          "
          role="status"
        >
          <p class="text-highlighted font-semibold">
            {{
              finalVote.result === "approved"
                ? t("session.preview.finalApproved")
                : t("session.preview.finalRejected")
            }}
          </p>
          <p class="text-default text-sm tabular-nums">
            {{ finalVoteMethodText }}
          </p>
          <div v-if="canAnnul" class="mt-2 flex flex-wrap items-center gap-2">
            <UButton
              size="xs"
              color="neutral"
              variant="outline"
              icon="i-lucide-rotate-ccw"
              :label="t('session.finalVote.annul')"
              @click="annulOpen = true"
            />
            <UButton
              v-if="canChangeUnanimity"
              size="xs"
              color="neutral"
              variant="ghost"
              :icon="
                finalVote.unanimous ? 'i-lucide-minus' : 'i-lucide-check-check'
              "
              :label="
                finalVote.unanimous
                  ? t('session.itemVote.unmarkUnanimous')
                  : t('session.itemVote.markUnanimous')
              "
              :aria-busy="unanimityBusy || undefined"
              @click="toggleUnanimity"
            />
          </div>
        </div>
        <template v-else>
          <UButton
            block
            icon="i-lucide-gavel"
            :label="t('session.finalVote.open')"
            :disabled="
              finalBlocked || !document.can.moderate || !session.inSession.value
            "
            :aria-describedby="finalBlocked ? reasonsId : undefined"
            @click="session.finalVoteDialog.open = true"
          />
          <div aria-live="polite">
            <ul
              v-if="finalBlocked"
              :id="reasonsId"
              class="text-muted space-y-1 text-xs"
            >
              <li v-for="reason in finalBlockedReasons" :key="reason">
                {{ reason }}
              </li>
            </ul>
          </div>
          <UButton
            v-if="finalBlocked && awaitingValidation > 0 && validationPath"
            :to="validationPath"
            target="_blank"
            size="xs"
            color="neutral"
            variant="link"
            class="px-0"
            trailing-icon="i-lucide-external-link"
            :label="t('session.queue.openValidation')"
            :aria-label="t('session.queue.openValidationNewTab')"
          />
        </template>
      </section>

      <CommonEmptyState
        v-if="!structured"
        icon="i-lucide-file-type"
        size="sm"
        :title="t('session.preview.fileDocument')"
      />
      <template v-else>
        <UAlert
          v-if="preview.conflicts.length > 0"
          color="error"
          variant="subtle"
          icon="i-lucide-git-compare"
          :title="
            t(
              'session.preview.conflictsTitle',
              { count: preview.conflicts.length },
              preview.conflicts.length,
            )
          "
        >
          <template #description>
            <ul class="mt-1 list-disc space-y-1 ps-4">
              <li
                v-for="conflict in preview.conflicts"
                :key="conflict.amendmentId"
              >
                <button
                  type="button"
                  class="focus-visible:ring-primary rounded text-start underline-offset-2 outline-none hover:underline focus-visible:ring-2"
                  @click="focusAmendment(conflict.amendmentId)"
                >
                  {{ conflictText(conflict) }}
                </button>
              </li>
            </ul>
          </template>
        </UAlert>

        <section v-if="preview.passages.length > 0" class="space-y-2">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.wording.passagesTitle") }}
          </h3>
          <ul
            class="border-default divide-default divide-y rounded-lg border text-sm"
          >
            <li
              v-for="passage in preview.passages"
              :key="passage.key"
              class="flex flex-wrap items-center gap-2 px-3 py-2"
            >
              <UBadge
                :color="PASSAGE_COLORS[passage.status]"
                variant="subtle"
                size="sm"
                :label="t(`session.wording.status.${passage.status}`)"
              />
              <span class="min-w-0 flex-1">
                {{ passage.amendmentIds.map(session.label).join(", ") }}
              </span>
              <UButton
                v-if="canWord"
                size="xs"
                color="neutral"
                variant="outline"
                :icon="
                  passage.status === 'pending'
                    ? 'i-lucide-pen-line'
                    : 'i-lucide-eye'
                "
                :label="
                  t(
                    passage.status === 'pending'
                      ? 'session.wording.set'
                      : 'session.wording.review',
                  )
                "
                @click="session.openWording(passage)"
              />
            </li>
          </ul>
        </section>

        <p class="text-muted text-xs" aria-live="polite">
          {{
            t(
              "session.preview.applied",
              { count: preview.applied.length },
              preview.applied.length,
            )
          }}
        </p>

        <ContentView
          :annotated="preview.annotated"
          mode="provenance"
          :label="session.label"
          :focus="session.focusedId.value"
          interactive
          @amendment-click="focusAmendment"
        >
          <template #empty>
            <p class="text-muted text-sm">{{ t("session.preview.empty") }}</p>
          </template>
        </ContentView>
      </template>
    </template>

    <UModal
      v-model:open="annulOpen"
      :title="t('session.finalVote.annulTitle')"
      :description="t('session.finalVote.annulDescription')"
    >
      <template #body>
        <form
          id="session-final-vote-annul-form"
          class="space-y-4"
          @submit.prevent="annul"
        >
          <UFormField
            :label="t('session.finalVote.annulNote')"
            :hint="t('session.vote.optional')"
            name="final-vote-annul-note"
          >
            <UTextarea
              v-model="annulNote"
              :rows="2"
              autoresize
              :maxlength="2000"
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
            form="session-final-vote-annul-form"
            color="error"
            icon="i-lucide-rotate-ccw"
            :label="t('session.finalVote.annulSubmit')"
            :loading="Boolean(session.busy.value['final-vote-annul'])"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
