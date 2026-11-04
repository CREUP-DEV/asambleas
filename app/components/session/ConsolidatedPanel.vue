<script setup lang="ts">
import type { ConsolidationConflict } from "~~/shared/types/content";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * The text as it stands: the base with every approved amendment applied in
 * approval order, each fragment linked to its amendment (provenance), the
 * conflicts that stop amendments from applying together, and the final vote.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const document = computed(() => session.document.value);
const preview = computed(() => session.preview.value);
const structured = computed(() => document.value?.format === "structured");
const finalVote = computed(() => document.value?.finalVote ?? null);
const undecided = computed(() => session.undecided.value.length);

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

const finalBlockedReason = computed(() => {
  if (!document.value) return null;
  if (!document.value.voted) return t("session.preview.notVoted");
  if (document.value.status !== "published")
    return t("session.preview.notPublished");
  if (undecided.value > 0)
    return t(
      "session.preview.undecided",
      { count: undecided.value },
      undecided.value,
    );
  return null;
});
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading" class="space-y-3" aria-busy="true">
      <USkeleton class="h-6 w-1/2" />
      <USkeleton v-for="n in 5" :key="n" class="h-16 w-full" />
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
            {{
              t("session.card.voteCounts", {
                inFavor: finalVote.inFavor,
                against: finalVote.against,
                abstentions: finalVote.abstentions,
              })
            }}
          </p>
        </div>
        <template v-else>
          <UButton
            block
            icon="i-lucide-gavel"
            :label="t('session.finalVote.open')"
            :disabled="Boolean(finalBlockedReason) || !document.can.moderate"
            @click="session.finalVoteDialog.open = true"
          />
          <p v-if="finalBlockedReason" class="text-muted text-xs">
            {{ finalBlockedReason }}
          </p>
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
          v-if="preview.totalityReturn"
          color="warning"
          variant="subtle"
          icon="i-lucide-undo-2"
          :title="
            t('session.preview.totalityReturn', {
              code: session.label(preview.totalityReturn.id),
            })
          "
        />
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
  </div>
</template>
