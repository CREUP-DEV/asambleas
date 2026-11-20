<script setup lang="ts">
import type { SessionAssentSkipReason } from "~/composables/session/sessionModel";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Approves by assent (a vote nobody opposes), in one go, the amendments it
 * was opened on (session.openAssent): every admitted amendment the
 * document's main presenter accepted (the shortcut, offered whenever there
 * are some: in a document that incorporates accepted amendments there are
 * none, since accepting already approved them), or a bloc the Mesa picked
 * or has on screen (user's decision of 2026-11-19), where those the main
 * presenter has not accepted say so. Amendments with a pending
 * transactional over them (approving them would withdraw it), or that would
 * collide with an approved one, with a transactional still to be decided or
 * with an earlier one of the batch, are left for the Mesa and listed with
 * the reason (sessionAssentPlan).
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.assentDialog.open,
  set: (value: boolean) => {
    session.assentDialog.open = value;
  },
});
const plan = computed(() => session.assentDialogPlan.value);
const bloc = computed(() => session.assentDialog.bloc);
const notAccepted = computed(() => new Set(plan.value.notAccepted));

/** Its code; one not published yet (a member's transactional) has none. */
function codeOf(id: string): string {
  const amendment = session.byId.value.get(id);
  return amendment
    ? (amendment.code ?? t("amendment.unnumberedLabel"))
    : session.label(id);
}

function skipReason(
  reason: SessionAssentSkipReason,
  conflictsWith: string[],
): string {
  return t(
    `session.assent.skip.${reason}`,
    {
      codes: conflictsWith.map(codeOf).join(", "),
      count: conflictsWith.length,
    },
    Math.max(conflictsWith.length, 1),
  );
}

async function submit(): Promise<void> {
  const ids = plan.value.ready.map((amendment) => amendment.id);
  if (ids.length === 0) return;
  await session.bulkAssent(ids);
  open.value = false;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="bloc ? t('session.bloc.assentTitle') : t('session.assent.title')"
    :description="
      bloc
        ? t('session.bloc.assentDescription')
        : t('session.assent.description')
    "
  >
    <template #body>
      <div class="space-y-4">
        <!-- Whatever opened it, a bloc on screen is what gets approved. -->
        <UAlert
          v-if="session.assentDialog.onScreen"
          color="info"
          variant="subtle"
          icon="i-lucide-monitor"
          :title="t('session.bloc.assentOnScreen')"
        />
        <CommonEmptyState
          v-if="plan.ready.length === 0"
          icon="i-lucide-check-check"
          size="sm"
          :title="
            bloc ? t('session.bloc.assentEmpty') : t('session.assent.empty')
          "
        />
        <section v-else class="space-y-2">
          <h3 class="text-highlighted text-sm font-medium">
            {{
              t(
                "session.assent.ready",
                { count: plan.ready.length },
                plan.ready.length,
              )
            }}
          </h3>
          <ul class="flex flex-wrap gap-2">
            <li
              v-for="amendment in plan.ready"
              :key="amendment.id"
              class="flex items-center gap-1"
            >
              <UBadge
                color="success"
                variant="subtle"
                :label="session.label(amendment.id)"
              />
              <span
                v-if="notAccepted.has(amendment.id)"
                class="text-muted text-xs"
              >
                {{ t("session.bloc.notAccepted") }}
              </span>
            </li>
          </ul>
        </section>
        <section v-if="plan.skipped.length > 0" class="space-y-2">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.assent.skippedTitle") }}
          </h3>
          <ul class="border-default divide-default divide-y rounded-lg border">
            <li
              v-for="entry in plan.skipped"
              :key="entry.amendment.id"
              class="px-3 py-2 text-sm"
            >
              <span class="font-semibold">{{
                session.label(entry.amendment.id)
              }}</span>
              <span class="text-muted">
                · {{ skipReason(entry.reason, entry.conflictsWith) }}</span
              >
            </li>
          </ul>
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
        <UButton
          icon="i-lucide-check-check"
          :label="
            t(
              'session.assent.submit',
              { count: plan.ready.length },
              plan.ready.length,
            )
          "
          :loading="Boolean(session.busy.value['bulk-assent'])"
          :disabled="plan.ready.length === 0"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
