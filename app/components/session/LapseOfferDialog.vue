<script setup lang="ts">
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * After a decision, offers to mark as lapsed ("decae") the undecided
 * amendments someone linked to it by hand (sessionLapseOffer): incompatible,
 * duplicate or subsumed ones, or those that depended on a rejected one.
 * Nothing is ticked: the Mesa picks which ones lapse.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

const open = computed({
  get: () => session.lapseDialog.open,
  set: (value: boolean) => {
    session.lapseDialog.open = value;
  },
});
const target = computed(() =>
  session.lapseDialog.targetId
    ? (session.byId.value.get(session.lapseDialog.targetId) ?? null)
    : null,
);

// Nothing is ticked: the Mesa picks which ones lapse, so one click never
// lapses them all (user's decision of 2026-11-19).
const selected = ref<string[]>([]);
watch(open, (isOpen) => {
  if (isOpen) selected.value = [];
});

const candidates = computed(() =>
  session.lapseDialog.lapse
    .map((id) => session.byId.value.get(id))
    .filter((amendment) => amendment !== undefined),
);

function toggle(id: string, value: boolean | "indeterminate"): void {
  selected.value =
    value === true
      ? [...new Set([...selected.value, id])]
      : selected.value.filter((other) => other !== id);
}

async function submit(): Promise<void> {
  if (selected.value.length === 0) return;
  await session.lapseMany(selected.value);
  open.value = false;
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="
      target
        ? t('session.lapse.title', { code: session.label(target.id) })
        : t('session.lapse.titleBatch')
    "
    :description="
      target?.status === 'rejected'
        ? t('session.lapse.descriptionRejected')
        : t('session.lapse.descriptionApproved')
    "
  >
    <template #body>
      <div class="space-y-4">
        <fieldset v-if="candidates.length > 0" class="space-y-2">
          <legend class="text-highlighted mb-2 text-sm font-medium">
            {{ t("session.lapse.candidates") }}
          </legend>
          <ul class="border-default divide-default divide-y rounded-lg border">
            <li
              v-for="amendment in candidates"
              :key="amendment.id"
              class="flex flex-wrap items-center gap-2 px-3 py-2"
            >
              <UCheckbox
                :model-value="selected.includes(amendment.id)"
                :aria-label="
                  t('session.lapse.select', {
                    code: session.label(amendment.id),
                  })
                "
                @update:model-value="(value) => toggle(amendment.id, value)"
              />
              <span class="font-semibold">{{
                session.label(amendment.id)
              }}</span>
              <CommonMemberBadge
                v-for="author in amendment.authors"
                :key="author.id"
                :member="author"
              />
              <!-- Lapsing it withdraws a pending transactional over it. -->
              <p
                v-if="session.transactionalsOver.line(amendment)"
                class="text-default flex w-full items-start gap-1.5 text-xs"
              >
                <UIcon
                  name="i-lucide-git-merge"
                  class="text-warning mt-px size-3.5 shrink-0"
                  aria-hidden="true"
                />
                {{ session.transactionalsOver.line(amendment) }}
              </p>
            </li>
          </ul>
        </fieldset>
      </div>
    </template>
    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('session.lapse.keep')"
          @click="close"
        />
        <UButton
          v-if="candidates.length > 0"
          color="warning"
          icon="i-lucide-circle-slash"
          :label="
            t(
              'session.lapse.submit',
              { count: selected.length },
              selected.length,
            )
          "
          :loading="Boolean(session.busy.value['lapse-many'])"
          :disabled="selected.length === 0"
          @click="submit"
        />
      </div>
    </template>
  </UModal>
</template>
