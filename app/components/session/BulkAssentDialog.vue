<script setup lang="ts">
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Approves by assent, in one go, every admitted amendment the proponent
 * accepted. Only offered when the assembly incorporates accepted amendments
 * by assent. Amendments that would collide with an approved one, or with an
 * earlier one of the batch, are left for the Mesa and listed.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.assentDialog.open,
  set: (value: boolean) => {
    session.assentDialog.open = value;
  },
});
const plan = computed(() => session.assentPlan.value);

function skipReason(
  reason: "acceptances" | "overlap_approved" | "overlap_candidate",
  conflictsWith: string[],
): string {
  return t(`session.assent.skip.${reason}`, {
    codes: conflictsWith.map(session.label).join(", "),
  });
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
    :title="t('session.assent.title')"
    :description="t('session.assent.description')"
  >
    <template #body>
      <div class="space-y-4">
        <CommonEmptyState
          v-if="plan.ready.length === 0"
          icon="i-lucide-check-check"
          size="sm"
          :title="t('session.assent.empty')"
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
            <li v-for="amendment in plan.ready" :key="amendment.id">
              <UBadge
                color="success"
                variant="subtle"
                :label="session.label(amendment.id)"
              />
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
