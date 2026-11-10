<script setup lang="ts">
import type { AssemblyDto, CalendarBody } from "~~/shared/types/api";
import { formatDateTime } from "~/utils/format";

/**
 * Marks the agenda as final (ODD definitivo) or reopens it as provisional,
 * for managers, after a confirmation that says what each means.
 *
 * - `button`: "Marcar como definitivo" (outline, so it never competes with
 *   the header's primary action) while the agenda is provisional and
 *   "Reabrir como provisional" once it is final (agenda page header).
 * - `reminder`: an alert with the same button, only when the planned date of
 *   the final agenda has passed and the agenda is still provisional (agenda
 *   page and assembly overview).
 *
 * Both write through PUT /calendar with no milestones, which records
 * `agenda_finalized` or `agenda_reopened`.
 */
const props = withDefaults(defineProps<{ as?: "button" | "reminder" }>(), {
  as: "button",
});

const { t, locale } = useI18n();
const toast = useToast();
const api = useApi();
const current = useCurrentAssembly();
const { assembly } = current;

// The shared clock, so the reminder shows when the date passes in an open tab.
const now = useAppNow();

const manage = computed(() => Boolean(assembly.value?.can.manage));
const isFinal = computed(() => Boolean(assembly.value?.agendaFinalizedAt));

/** The planned date of the final agenda, once it has passed. */
const overdueSince = computed<string | null>(() => {
  if (isFinal.value) return null;
  const planned = assembly.value?.milestones.find(
    (milestone) => milestone.key === "agenda_final",
  );
  return planned && new Date(planned.at).getTime() <= now.value
    ? planned.at
    : null;
});

const open = ref(false);
const saving = ref(false);
/** What the open confirmation will do: true marks as final. */
const target = ref(true);

function ask(final: boolean) {
  target.value = final;
  open.value = true;
}

async function confirm() {
  if (!assembly.value || saving.value) return;
  const body: CalendarBody = { milestones: [], agendaFinal: target.value };
  saving.value = true;
  try {
    const updated = await api.send<AssemblyDto>(
      `${current.apiBase.value}/calendar`,
      { method: "PUT", body },
    );
    current.setAssembly(updated);
    open.value = false;
    toast.add({
      title: target.value
        ? t("agenda.finalAgenda.marked")
        : t("agenda.finalAgenda.reopened"),
      color: "success",
      icon: target.value ? "i-lucide-lock" : "i-lucide-lock-open",
    });
  } catch (error) {
    api.notifyError(error, "agenda.finalAgenda.error");
    if (api.isConflict(error)) await current.refresh();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <template v-if="manage">
    <template v-if="props.as === 'button'">
      <!-- Outline: the header's one solid action is adding a document -->
      <UButton
        v-if="!isFinal"
        color="neutral"
        variant="outline"
        icon="i-lucide-lock"
        :label="t('agenda.finalAgenda.mark')"
        data-testid="agenda-mark-final"
        @click="ask(true)"
      />
      <UButton
        v-else
        color="neutral"
        variant="ghost"
        icon="i-lucide-lock-open"
        :label="t('agenda.finalAgenda.reopen')"
        data-testid="agenda-reopen"
        @click="ask(false)"
      />
    </template>

    <UAlert
      v-else-if="overdueSince"
      color="warning"
      variant="subtle"
      icon="i-lucide-calendar-clock"
      :title="t('agenda.finalAgenda.overdueTitle')"
      :description="
        t('agenda.finalAgenda.overdueDescription', {
          date: formatDateTime(overdueSince, { style: 'long', locale }),
        })
      "
      :actions="[
        {
          label: t('agenda.finalAgenda.mark'),
          icon: 'i-lucide-lock',
          color: 'neutral',
          variant: 'outline',
          onClick: () => ask(true),
        },
      ]"
      data-testid="agenda-final-reminder"
    />

    <UModal
      v-model:open="open"
      :title="
        target
          ? t('agenda.finalAgenda.markTitle')
          : t('agenda.finalAgenda.reopenTitle')
      "
      :description="
        target
          ? t('agenda.finalAgenda.markDescription')
          : t('agenda.finalAgenda.reopenDescription')
      "
      :dismissible="!saving"
    >
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="saving"
            @click="open = false"
          />
          <UButton
            :icon="target ? 'i-lucide-lock' : 'i-lucide-lock-open'"
            :label="
              target
                ? t('agenda.finalAgenda.mark')
                : t('agenda.finalAgenda.reopen')
            "
            :loading="saving"
            @click="confirm"
          />
        </div>
      </template>
    </UModal>
  </template>
</template>
