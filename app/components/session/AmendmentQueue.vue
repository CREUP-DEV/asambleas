<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import {
  sessionValidationBreakdown,
  sessionValidationIds,
} from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";
import { assemblyPath } from "~/components/shell/Navigation.vue";

/**
 * The amendments of the document on screen, in text order, as a compact
 * list: one line each (code, who, one status) that opens into its details
 * and actions. What is debated now leads the console (NowPanel); this list
 * is where the Mesa looks ahead. Its title names the document, and when it
 * is not the one the room is debating (picked in the agenda) it says so:
 * debating from here moves the room to it, after asking.
 *
 * Late amendments come first, as "Fuera de plazo": the assembly decides
 * whether to treat them (AdmissionDialog) and only then can they be debated
 * and decided. Amendments that change the same passage are grouped with a
 * one-click transactional. In a document that incorporates accepted
 * amendments, a line says so: those the main presenter accepts are
 * already in the text. Those the Secretaría has not validated yet (or a
 * member's transactional the main authors have not accepted yet) sit
 * apart, folded away, since the Mesa cannot debate them: whoever can
 * validate them does it there (asking first when it is several at once) or
 * opens them in Validación, where they can also be sent back.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();
const localePath = useLocalePath();

const document = computed(() => session.document.value);
/** The heading names the document the list belongs to. */
const title = computed(() => {
  const current = document.value;
  const name = current?.reference ?? current?.title ?? null;
  return name
    ? t("session.queue.titleFor", { document: name })
    : t("session.queue.title");
});
/** A Mesa member picked another document than the one the room debates. */
const notLive = computed(
  () => Boolean(document.value) && !session.showingLiveDocument.value,
);
const queue = computed(() => session.queue.value);
const visible = (amendment: AmendmentDto) => session.isVisible(amendment);

const pending = computed(() => queue.value.pending);
const pendingIds = computed(() =>
  pending.value.map((amendment) => amendment.id),
);
const awaitingValidation = computed(() => queue.value.validation);
const validationOpen = ref(false);
const validatable = computed(() =>
  sessionValidationIds(awaitingValidation.value),
);
const validating = computed(() => Boolean(session.busy.value.validate));
/** Who the folded group waits for, as one short line under its title. */
const validationDetail = computed(() => {
  const { toValidate, inCorrection, awaitingAuthors } =
    sessionValidationBreakdown(awaitingValidation.value);
  return [
    awaitingAuthors > 0
      ? t(
          "session.queue.validationAwaitingAuthors",
          { count: awaitingAuthors },
          awaitingAuthors,
        )
      : null,
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

/**
 * Admitted amendments the main presenter accepts, ready to be approved
 * together by assent (a way of voting when nobody opposes). In a document
 * that incorporates accepted amendments there are none: accepting already
 * approved them.
 */
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
  <section class="space-y-3" aria-labelledby="session-queue-title">
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2
        id="session-queue-title"
        class="text-highlighted min-w-0 text-base font-semibold"
      >
        {{ title }}
      </h2>
      <p
        v-if="document && session.amendmentsDto.value && counts.total > 0"
        class="text-muted text-sm"
        aria-live="polite"
      >
        {{
          t("session.queue.counts", {
            total: counts.total,
            undecided: counts.undecided,
            approved: counts.approved,
          })
        }}
      </p>
    </div>

    <p
      v-if="notLive"
      class="text-muted flex items-start gap-1.5 text-sm"
      role="note"
    >
      <UIcon
        name="i-lucide-eye"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      {{ t("session.queue.notLive") }}
    </p>

    <p
      v-if="
        document && document.amendable && session.incorporatesAccepted.value
      "
      class="text-muted flex items-start gap-1.5 text-sm"
      role="note"
    >
      <UIcon
        name="i-lucide-file-check-2"
        class="mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      {{ t("session.queue.incorporateRule") }}
    </p>

    <div v-if="loading" class="space-y-2" role="status">
      <span class="sr-only">{{ t("session.queue.loading") }}</span>
      <USkeleton v-for="n in 5" :key="n" class="h-11 w-full" />
    </div>

    <CommonEmptyState
      v-else-if="!session.documentId.value"
      icon="i-lucide-file-search"
      size="sm"
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
      <CommonEmptyState
        v-if="!document.amendable || document.format === 'file'"
        icon="i-lucide-file-lock"
        size="sm"
        :title="t('session.queue.notAmendable')"
        :description="t('session.queue.notAmendableHint')"
      />
      <CommonEmptyState
        v-else-if="counts.total === 0 && awaitingValidation.length === 0"
        icon="i-lucide-inbox"
        size="sm"
        :title="t('session.queue.empty')"
        :description="t('session.queue.emptyHint')"
      />

      <div
        v-if="counts.total > 0"
        class="flex flex-wrap items-center gap-x-4 gap-y-2"
      >
        <USwitch
          v-model="hideDecided"
          size="sm"
          :label="t('session.queue.hideDecided')"
        />
        <UTooltip
          v-if="readyForAssent > 0"
          :text="t('session.queue.assentHint')"
        >
          <UButton
            size="xs"
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
            @click="session.assentDialog.open = true"
          />
        </UTooltip>
      </div>

      <!-- Late: the assembly decides whether to treat them first. -->
      <section
        v-if="pending.length > 0"
        class="border-warning/50 bg-warning/5 space-y-2 rounded-xl border p-3"
        aria-labelledby="session-queue-late"
      >
        <div class="flex flex-wrap items-center gap-2">
          <UIcon
            name="i-lucide-clock-alert"
            class="text-warning size-5 shrink-0"
            aria-hidden="true"
          />
          <h3 id="session-queue-late" class="text-highlighted font-semibold">
            {{
              t(
                "session.queue.lateTitle",
                { count: pending.length },
                pending.length,
              )
            }}
          </h3>
          <UButton
            class="ms-auto"
            size="xs"
            color="warning"
            variant="soft"
            icon="i-lucide-gavel"
            :label="
              t(
                'session.queue.lateDecide',
                { count: pending.length },
                pending.length,
              )
            "
            :disabled="Boolean(session.busy.value.admission)"
            @click="session.openAdmission(pendingIds, 'admitted')"
          />
        </div>
        <p class="text-muted text-sm">{{ t("session.queue.lateHint") }}</p>
        <ul class="space-y-1.5">
          <li v-for="amendment in pending" :key="amendment.id">
            <SessionQueueRow :amendment="amendment" />
          </li>
        </ul>
      </section>

      <ol class="space-y-1.5" :aria-label="t('session.queue.listLabel')">
        <li
          v-for="entry in entries"
          :key="entry.type === 'cluster' ? `c-${entry.id}` : entry.amendment.id"
        >
          <SessionQueueRow
            v-if="entry.type === 'amendment'"
            :amendment="entry.amendment"
          />
          <section
            v-else
            class="border-error/30 space-y-1.5 rounded-xl border border-dashed p-2"
            :aria-label="
              t(
                'session.queue.clusterLabel',
                { count: entry.amendments.length },
                entry.amendments.length,
              )
            "
          >
            <div class="flex flex-wrap items-center gap-2 px-1">
              <UIcon
                name="i-lucide-git-compare"
                class="text-error size-4 shrink-0"
                aria-hidden="true"
              />
              <p class="text-highlighted min-w-0 flex-1 text-sm font-medium">
                {{
                  t("session.queue.clusterTitle", {
                    codes: entry.amendments
                      .map((a) => session.label(a.id))
                      .join(", "),
                  })
                }}
              </p>
              <UTooltip
                v-if="entry.openIds.length >= 2"
                :text="t('session.queue.clusterHint')"
              >
                <UButton
                  size="xs"
                  color="secondary"
                  variant="soft"
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
              </UTooltip>
            </div>
            <ul class="space-y-1.5">
              <li v-for="amendment in entry.amendments" :key="amendment.id">
                <SessionQueueRow :amendment="amendment" />
              </li>
            </ul>
          </section>
        </li>
      </ol>

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
            <ul class="space-y-1.5">
              <li v-for="amendment in awaitingValidation" :key="amendment.id">
                <SessionQueueRow :amendment="amendment" />
              </li>
            </ul>
          </template>
        </UCollapsible>
      </section>
    </template>
  </section>
</template>
