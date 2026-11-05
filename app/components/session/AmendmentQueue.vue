<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import {
  sessionValidationBreakdown,
  sessionValidationIds,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { assemblyPath } from "~/components/shell/Navigation.vue";

/**
 * The amendments of the document on screen, in text order. Late ones
 * waiting for admission come first; amendments that change the same passage
 * are grouped with a conflict callout and a one-click transactional. Those
 * the Secretaría has not validated yet sit apart, folded away, since the
 * Mesa cannot debate them: whoever can validate them does it there (asking
 * first when it is several at once) or opens them in Validación, where they
 * can also be sent back to their authors.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();
const localePath = useLocalePath();

const document = computed(() => session.document.value);
const queue = computed(() => session.queue.value);
const visible = (amendment: AmendmentDto) => session.isVisible(amendment);

const pending = computed(() => queue.value.pending);
const awaitingValidation = computed(() => queue.value.validation);
const validationOpen = ref(false);
const validatable = computed(() =>
  sessionValidationIds(awaitingValidation.value),
);
const validating = computed(() => Boolean(session.busy.value.validate));
/** Who the folded group waits for, as one short line under its title. */
const validationDetail = computed(() => {
  const { toValidate, inCorrection } = sessionValidationBreakdown(
    awaitingValidation.value,
  );
  return [
    toValidate > 0
      ? t(
          "session.queue.validationToValidate",
          { count: toValidate },
          toValidate,
        )
      : null,
    inCorrection > 0
      ? t(
          "session.queue.validationInCorrection",
          { count: inCorrection },
          inCorrection,
        )
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
});
const validationPath = computed(() =>
  session.assembly.value
    ? localePath(assemblyPath(session.assembly.value.slug, "validation"))
    : null,
);

/** Validating several at once publishes them all: ask first. */
async function validateAll(): Promise<void> {
  const ids = validatable.value;
  const count = ids.length;
  if (count === 0) return;
  const confirmed = await session.confirm({
    title: t("session.validateConfirm.title", { count }, count),
    description: t("session.validateConfirm.description", { count }, count),
    items: ids.map(session.label),
    confirmLabel: t("session.actions.validate"),
    confirmIcon: "i-lucide-badge-check",
  });
  if (confirmed) await session.validateAmendments(ids);
}
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

const counts = computed(() => session.queueCounts.value);

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
    <div v-if="loading" class="space-y-3" role="status">
      <span class="sr-only">{{ t("session.queue.loading") }}</span>
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
        v-else-if="counts.total === 0 && awaitingValidation.length === 0"
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

      <!-- Not validated by the Secretaría yet: outside the debate, folded away. -->
      <section
        v-if="awaitingValidation.length > 0"
        :aria-label="
          t(
            'session.queue.validationTitle',
            { count: awaitingValidation.length },
            awaitingValidation.length,
          )
        "
      >
        <UCollapsible
          v-model:open="validationOpen"
          class="border-default rounded-xl border"
          :ui="{ content: 'space-y-3 px-3 pb-3' }"
        >
          <UButton
            color="neutral"
            variant="ghost"
            block
            icon="i-lucide-hourglass"
            trailing-icon="i-lucide-chevron-down"
            class="group justify-start rounded-xl p-3"
            :ui="{
              leadingIcon: 'self-start mt-0.5',
              trailingIcon:
                'ms-auto self-start mt-0.5 transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none',
            }"
          >
            <span class="flex min-w-0 flex-col items-start text-start">
              <span class="text-highlighted font-semibold">
                {{
                  t(
                    "session.queue.validationTitle",
                    { count: awaitingValidation.length },
                    awaitingValidation.length,
                  )
                }}
              </span>
              <span
                v-if="validationDetail"
                class="text-muted text-xs font-normal"
              >
                {{ validationDetail }}
              </span>
            </span>
          </UButton>

          <template #content>
            <p class="text-muted text-sm">
              {{
                validatable.length > 0
                  ? t("session.queue.validationHintCanValidate")
                  : t("session.queue.validationHint")
              }}
            </p>
            <div
              v-if="validatable.length > 0"
              class="flex flex-wrap items-center gap-x-4 gap-y-2"
            >
              <UButton
                v-if="validatable.length >= 2"
                size="sm"
                color="primary"
                variant="soft"
                icon="i-lucide-badge-check"
                :label="
                  t(
                    'session.queue.validateAll',
                    { count: validatable.length },
                    validatable.length,
                  )
                "
                :loading="validating"
                @click="validateAll"
              />
              <UButton
                v-if="validationPath"
                :to="validationPath"
                target="_blank"
                size="sm"
                color="neutral"
                variant="link"
                class="px-0"
                trailing-icon="i-lucide-external-link"
                :label="t('session.queue.openValidation')"
                :aria-label="t('session.queue.openValidationNewTab')"
              />
            </div>
            <SessionAmendmentCard
              v-for="amendment in awaitingValidation"
              :key="amendment.id"
              :amendment="amendment"
            />
          </template>
        </UCollapsible>
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
