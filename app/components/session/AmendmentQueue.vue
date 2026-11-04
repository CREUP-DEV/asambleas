<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * The amendments of the document on screen, in text order. Late ones
 * waiting for admission come first; amendments that change the same passage
 * are grouped with a conflict callout and a one-click transactional.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const document = computed(() => session.document.value);
const queue = computed(() => session.queue.value);
const visible = (amendment: AmendmentDto) => session.isVisible(amendment);

const pending = computed(() => queue.value.pending);
const entries = computed(() =>
  queue.value.entries
    .map((entry) =>
      entry.type === "amendment"
        ? visible(entry.amendment)
          ? entry
          : null
        : {
            ...entry,
            amendments: entry.amendments.filter(visible),
          },
    )
    .filter(
      (entry) =>
        entry !== null &&
        (entry.type === "amendment" || entry.amendments.length > 0),
    )
    .map((entry) => entry!),
);

const counts = computed(() => {
  const list = session.amendments.value.filter(
    (amendment) => amendment.status !== "draft",
  );
  return {
    total: list.length,
    undecided: list.filter((amendment) => amendment.status === "submitted")
      .length,
    approved: list.filter((amendment) => amendment.status === "approved")
      .length,
  };
});

const hideDecided = computed({
  get: () => session.hideDecided.value,
  set: (value: boolean) => {
    session.hideDecided.value = value;
  },
});

const assentByVote = computed(
  () => session.settings.value.acceptedAmendments === "vote",
);
const readyForAssent = computed(() => session.assentPlan.value.ready.length);

const loading = computed(
  () =>
    !session.amendmentsDto.value &&
    (session.amendmentsStatus.value === "pending" ||
      session.documentStatus.value === "pending"),
);
const failed = computed(
  () => Boolean(session.amendmentsError.value) && !session.amendmentsDto.value,
);
</script>

<template>
  <div class="space-y-4">
    <div v-if="loading" class="space-y-3" aria-busy="true">
      <USkeleton v-for="n in 4" :key="n" class="h-24 w-full" />
    </div>

    <CommonEmptyState
      v-else-if="!session.documentId.value"
      icon="i-lucide-file-search"
      :title="t('session.queue.noDocument')"
      :description="t('session.queue.noDocumentHint')"
    />

    <UAlert
      v-else-if="failed"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('session.queue.error')"
      :actions="[
        {
          label: t('session.actions.retry'),
          color: 'neutral',
          variant: 'outline',
          onClick: () => {
            void session.refreshAmendments();
          },
        },
      ]"
    />

    <template v-else-if="document">
      <header class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="text-highlighted min-w-0 text-lg font-semibold">
            {{ document.title }}
          </h2>
          <UBadge
            v-if="document.reference"
            color="neutral"
            variant="outline"
            :label="document.reference"
          />
          <CommonStatusBadge kind="document" :value="document.status" />
        </div>
        <p class="text-muted text-sm" aria-live="polite">
          {{
            t("session.queue.counts", {
              total: counts.total,
              undecided: counts.undecided,
              approved: counts.approved,
            })
          }}
        </p>
        <div class="flex flex-wrap items-center gap-3">
          <USwitch
            v-model="hideDecided"
            :label="t('session.queue.hideDecided')"
          />
          <UTooltip
            :text="
              assentByVote
                ? t('session.queue.assentDisabled')
                : t('session.queue.assentHint')
            "
          >
            <UButton
              size="sm"
              color="success"
              variant="outline"
              icon="i-lucide-check-check"
              :label="
                t(
                  'session.queue.assentAccepted',
                  { count: readyForAssent },
                  readyForAssent,
                )
              "
              :disabled="assentByVote || readyForAssent === 0"
              @click="session.assentDialog.open = true"
            />
          </UTooltip>
        </div>
      </header>

      <CommonEmptyState
        v-if="!document.amendable || document.format === 'file'"
        icon="i-lucide-file-lock"
        :title="t('session.queue.notAmendable')"
        :description="t('session.queue.notAmendableHint')"
      />
      <CommonEmptyState
        v-else-if="counts.total === 0"
        icon="i-lucide-inbox"
        :title="t('session.queue.empty')"
        :description="t('session.queue.emptyHint')"
      />

      <section
        v-if="pending.length > 0"
        class="border-warning/50 bg-warning/5 space-y-3 rounded-xl border p-3"
        :aria-label="
          t(
            'session.queue.pendingTitle',
            { count: pending.length },
            pending.length,
          )
        "
      >
        <div class="flex flex-wrap items-center gap-2">
          <UIcon
            name="i-lucide-clock-alert"
            class="text-warning size-5"
            aria-hidden="true"
          />
          <h3 class="text-highlighted font-semibold">
            {{
              t(
                "session.queue.pendingTitle",
                { count: pending.length },
                pending.length,
              )
            }}
          </h3>
          <span class="ms-auto inline-flex flex-wrap gap-1.5">
            <UButton
              size="xs"
              color="success"
              icon="i-lucide-check"
              :label="t('session.queue.admitAll')"
              @click="
                session.openAdmission(
                  pending.map((amendment) => amendment.id),
                  'admitted',
                )
              "
            />
            <UButton
              size="xs"
              color="error"
              variant="soft"
              icon="i-lucide-octagon-x"
              :label="t('session.queue.inadmitAll')"
              @click="
                session.openAdmission(
                  pending.map((amendment) => amendment.id),
                  'inadmissible',
                )
              "
            />
          </span>
        </div>
        <p class="text-muted text-sm">{{ t("session.queue.pendingHint") }}</p>
        <SessionAmendmentCard
          v-for="amendment in pending"
          :key="amendment.id"
          :amendment="amendment"
        />
      </section>

      <ol class="space-y-3" :aria-label="t('session.queue.listLabel')">
        <li
          v-for="entry in entries"
          :key="entry.type === 'cluster' ? `c-${entry.id}` : entry.amendment.id"
        >
          <SessionAmendmentCard
            v-if="entry.type === 'amendment'"
            :amendment="entry.amendment"
          />
          <section
            v-else
            class="border-error/40 bg-error/5 space-y-3 rounded-xl border p-3"
            :aria-label="
              t(
                'session.queue.clusterLabel',
                { count: entry.amendments.length },
                entry.amendments.length,
              )
            "
          >
            <div class="flex flex-wrap items-start gap-2">
              <UIcon
                name="i-lucide-git-compare"
                class="text-error mt-0.5 size-5 shrink-0"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <p class="text-highlighted text-sm font-semibold">
                  {{
                    t("session.queue.clusterTitle", {
                      codes: entry.amendments
                        .map((a) => session.label(a.id))
                        .join(", "),
                    })
                  }}
                </p>
                <p class="text-muted text-xs">
                  {{ t("session.queue.clusterHint") }}
                </p>
              </div>
              <UButton
                v-if="entry.openIds.length >= 2"
                size="xs"
                color="secondary"
                icon="i-lucide-git-merge"
                :label="
                  t(
                    'session.queue.transactCluster',
                    { count: entry.openIds.length },
                    entry.openIds.length,
                  )
                "
                @click="session.openComposer(entry.openIds)"
              />
            </div>
            <SessionAmendmentCard
              v-for="amendment in entry.amendments"
              :key="amendment.id"
              :amendment="amendment"
            />
          </section>
        </li>
      </ol>
    </template>
  </div>
</template>
