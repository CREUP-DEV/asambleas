<script setup lang="ts">
import { MILESTONE_KEYS, type MilestoneKey } from "~~/shared/constants/domain";
import type { AssemblyDto, CalendarBody } from "~~/shared/types/api";
import {
  checkCalendar,
  defaultMilestones,
  wholeDaysBeforeStart,
  type Milestones,
} from "~~/shared/utils/calendar";
import { MILESTONE_NOTE_MAX_LENGTH } from "~~/shared/utils/schemas/assembly";

/**
 * Calendar editor: one date-time per milestone (Europe/Madrid), a note, the
 * regulatory defaults of the assembly type, live warnings from
 * checkCalendar, and the "final agenda" switch. Read-only for non-managers.
 */

const { t, locale } = useI18n();
const toast = useToast();
const api = useApi();
const current = useCurrentAssembly();
const { assembly, sectionPath } = current;

useHead({
  title: () =>
    [t("calendar.title"), assembly.value?.label].filter(Boolean).join(" · "),
});

interface MilestoneForm {
  at: string | null;
  note: string;
}

type CalendarForm = {
  milestones: Record<MilestoneKey, MilestoneForm>;
  agendaFinal: boolean;
};

function formFrom(value: AssemblyDto | null): CalendarForm {
  const milestones = Object.fromEntries(
    MILESTONE_KEYS.map((key) => [key, { at: null, note: "" }]),
  ) as Record<MilestoneKey, MilestoneForm>;
  for (const milestone of value?.milestones ?? []) {
    milestones[milestone.key] = {
      at: new Date(milestone.at).toISOString(),
      note: milestone.note ?? "",
    };
  }
  return { milestones, agendaFinal: Boolean(value?.agendaFinalizedAt) };
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return a === b;
  return new Date(a).getTime() === new Date(b).getTime();
}

const saved = ref<CalendarForm>(formFrom(assembly.value));
const form = reactive<CalendarForm>(formFrom(assembly.value));
const saving = ref(false);
const announcement = ref("");
const remoteChanged = ref(false);

const changedKeys = computed(() =>
  MILESTONE_KEYS.filter((key) => {
    const before = saved.value.milestones[key];
    const after = form.milestones[key];
    return (
      !sameInstant(before.at, after.at) ||
      (after.at !== null && before.note.trim() !== after.note.trim())
    );
  }),
);
const agendaFinalChanged = computed(
  () => saved.value.agendaFinal !== form.agendaFinal,
);
const changeCount = computed(
  () => changedKeys.value.length + (agendaFinalChanged.value ? 1 : 0),
);
const dirty = computed(() => changeCount.value > 0);

function resetForm(value: AssemblyDto | null) {
  const next = formFrom(value);
  saved.value = next;
  Object.assign(form, formFrom(value));
  remoteChanged.value = false;
}

// Changes from elsewhere: adopt them when the form is clean, warn otherwise.
watch(
  () =>
    assembly.value
      ? JSON.stringify([
          assembly.value.milestones,
          assembly.value.agendaFinalizedAt,
        ])
      : "",
  (next, previous) => {
    if (next === previous || saving.value) return;
    if (dirty.value) remoteChanged.value = true;
    else resetForm(assembly.value);
  },
);

// Warnings and defaults --------------------------------------------------

const formMap = computed<Milestones>(() => {
  const map: Milestones = {};
  for (const key of MILESTONE_KEYS) {
    const at = form.milestones[key].at;
    if (at) map[key] = new Date(at);
  }
  return map;
});

const warnings = computed(() =>
  assembly.value
    ? checkCalendar(
        assembly.value.type,
        new Date(assembly.value.startDate),
        formMap.value,
      )
    : [],
);
const warnedKeys = computed(
  () => new Set(warnings.value.flatMap((warning) => warning.keys)),
);

const defaults = computed<Milestones>(() =>
  assembly.value
    ? defaultMilestones(assembly.value.type, new Date(assembly.value.startDate))
    : {},
);

/**
 * Milestones in date order: the saved date, else the default one, else last
 * (ties keep the usual order). Sorted by what is saved, so a row does not jump
 * while someone types; it moves after saving.
 */
const orderedKeys = computed<MilestoneKey[]>(() => {
  const rank = (key: MilestoneKey) => {
    const at = saved.value.milestones[key].at;
    if (at) return new Date(at).getTime();
    return defaults.value[key]?.getTime() ?? Number.POSITIVE_INFINITY;
  };
  // Two undated keys give Infinity - Infinity = NaN, which falls through.
  return [...MILESTONE_KEYS].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      MILESTONE_KEYS.indexOf(a) - MILESTONE_KEYS.indexOf(b),
  );
});

const defaultsConfirmOpen = ref(false);

/** Whether applying the defaults would overwrite a date already set. */
const defaultsOverwrite = computed(() =>
  MILESTONE_KEYS.some((key) => {
    const proposed = defaults.value[key];
    const currentAt = form.milestones[key].at;
    return (
      proposed && currentAt && !sameInstant(currentAt, proposed.toISOString())
    );
  }),
);

function requestDefaults() {
  if (defaultsOverwrite.value) defaultsConfirmOpen.value = true;
  else applyDefaults();
}

function applyDefaults() {
  let applied = 0;
  for (const key of MILESTONE_KEYS) {
    const proposed = defaults.value[key];
    if (!proposed) continue;
    form.milestones[key].at = proposed.toISOString();
    applied += 1;
  }
  defaultsConfirmOpen.value = false;
  announcement.value = t(
    "calendar.defaultsApplied",
    { count: applied },
    applied,
  );
}

function clearMilestone(key: MilestoneKey) {
  form.milestones[key].at = null;
  form.milestones[key].note = "";
}

/** Offset from the assembly start, e.g. "12 días antes del inicio". */
function offsetLabel(key: MilestoneKey): string {
  const at = form.milestones[key].at;
  if (!at || !assembly.value) return "";
  const start = new Date(assembly.value.startDate);
  const date = new Date(at);
  const hours = Math.round((start.getTime() - date.getTime()) / 3_600_000);
  if (hours < 0) return t("calendar.afterStart");
  // Same time of day as the start: whole days, even across a clock change.
  const wholeDays = wholeDaysBeforeStart(start, date);
  if (wholeDays !== null) {
    return t("calendar.daysBeforeStart", { count: wholeDays }, wholeDays);
  }
  if (hours < 72 && hours % 24 !== 0) {
    return t("calendar.hoursBeforeStart", { count: hours }, hours);
  }
  const days = Math.round(hours / 24);
  return t("calendar.daysBeforeStart", { count: days }, days);
}

function defaultHint(key: MilestoneKey): string {
  const proposed = defaults.value[key];
  return proposed
    ? t("calendar.defaultHint", {
        date: formatDateTime(proposed, { locale: locale.value }),
      })
    : t("calendar.noDefault");
}

// Saving --------------------------------------------------------------------

async function save() {
  const value = assembly.value;
  if (!value || !dirty.value) return;
  const body: CalendarBody = {
    milestones: changedKeys.value.map((key) => {
      const milestone = form.milestones[key];
      return {
        key,
        at: milestone.at,
        note: milestone.at ? milestone.note.trim() || null : null,
      };
    }),
    ...(agendaFinalChanged.value ? { agendaFinal: form.agendaFinal } : {}),
  };
  saving.value = true;
  try {
    const updated = await api.send<AssemblyDto>(
      `${current.apiBase.value}/calendar`,
      {
        method: "PUT",
        body,
      },
    );
    current.setAssembly(updated);
    resetForm(updated);
    announcement.value = t("calendar.saved");
    toast.add({
      title: t("calendar.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    api.notifyError(error, "calendar.saveError");
    if (api.isConflict(error)) await current.refresh();
  } finally {
    saving.value = false;
  }
}

function discard() {
  resetForm(assembly.value);
  announcement.value = t("calendar.discarded");
}

onBeforeRouteLeave(() => {
  if (dirty.value && import.meta.client) {
    return window.confirm(t("calendar.unsavedConfirm"));
  }
  return true;
});

const fieldId = (key: MilestoneKey, field: "at" | "note" | "label") =>
  `milestone-${key}-${field}`;
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0 space-y-1">
        <h2 class="text-highlighted text-xl font-semibold">
          {{ t("calendar.title") }}
        </h2>
        <p class="text-muted max-w-prose text-sm">
          {{ t("calendar.intro") }}
        </p>
      </div>
      <UButton
        v-if="assembly.can.manage"
        color="neutral"
        variant="outline"
        icon="i-lucide-wand-sparkles"
        :label="t('calendar.applyDefaults')"
        @click="requestDefaults"
      />
    </div>

    <!-- Read-only view -->
    <template v-if="!assembly.can.manage">
      <UCard>
        <CalendarMilestoneTimeline
          :milestones="assembly.milestones"
          :start-date="assembly.startDate"
        />
      </UCard>
    </template>

    <form v-else class="space-y-6" novalidate @submit.prevent="save">
      <UAlert
        v-if="remoteChanged"
        color="info"
        variant="subtle"
        icon="i-lucide-refresh-ccw"
        :title="t('calendar.remoteChanged')"
        :description="t('calendar.remoteChangedDescription')"
        :actions="[
          {
            label: t('calendar.loadRemote'),
            color: 'info',
            variant: 'outline',
            onClick: discard,
          },
        ]"
        role="status"
      />

      <CalendarWarningList :warnings="warnings" />
      <p
        v-if="warnings.length === 0"
        class="text-success flex items-center gap-1.5 text-sm"
      >
        <UIcon name="i-lucide-circle-check" class="size-4" aria-hidden="true" />
        {{ t("calendar.noWarnings") }}
      </p>

      <UCard :ui="{ body: 'p-0 sm:p-0' }">
        <template #header>
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-highlighted font-semibold">
              {{ t("calendar.milestonesTitle") }}
            </h3>
            <span class="text-muted flex items-center gap-1.5 text-xs">
              <UIcon name="i-lucide-globe" class="size-4" aria-hidden="true" />
              {{ t("calendar.timeZoneHint") }}
            </span>
          </div>
        </template>

        <ul class="divide-default divide-y">
          <li
            v-for="key in orderedKeys"
            :key="key"
            class="grid gap-3 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]"
            :class="{ 'bg-warning/5': warnedKeys.has(key) }"
          >
            <div class="min-w-0 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <label
                  :id="fieldId(key, 'label')"
                  :for="fieldId(key, 'at')"
                  class="text-highlighted font-medium"
                >
                  {{ t(`calendar.milestones.${key}`) }}
                </label>
                <UBadge
                  v-if="warnedKeys.has(key)"
                  color="warning"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-triangle-alert"
                  :label="t('calendar.hasWarning')"
                />
                <UBadge
                  v-if="changedKeys.includes(key)"
                  color="info"
                  variant="soft"
                  size="sm"
                  :label="t('calendar.changed')"
                />
              </div>
              <p class="text-muted text-sm">
                {{ t(`calendar.explanations.${key}`) }}
              </p>
              <p class="text-dimmed text-xs">{{ defaultHint(key) }}</p>
            </div>

            <div class="space-y-2">
              <div class="flex items-center gap-2">
                <CalendarDateTimeInput
                  :id="fieldId(key, 'at')"
                  v-model="form.milestones[key].at"
                  :aria-labelledby="fieldId(key, 'label')"
                  :invalid="warnedKeys.has(key)"
                  :disabled="saving"
                  class="min-w-0 flex-1"
                />
                <UTooltip :text="t('calendar.clear')">
                  <UButton
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-eraser"
                    :aria-label="
                      t('calendar.clearMilestone', {
                        milestone: t(`calendar.milestones.${key}`),
                      })
                    "
                    :disabled="saving || !form.milestones[key].at"
                    @click="clearMilestone(key)"
                  />
                </UTooltip>
              </div>
              <p
                v-if="form.milestones[key].at"
                class="text-muted text-xs tabular-nums"
              >
                {{ offsetLabel(key) }}
              </p>
              <UInput
                v-if="form.milestones[key].at"
                :id="fieldId(key, 'note')"
                v-model="form.milestones[key].note"
                :placeholder="t('calendar.notePlaceholder')"
                :aria-label="
                  t('calendar.noteLabel', {
                    milestone: t(`calendar.milestones.${key}`),
                  })
                "
                :maxlength="MILESTONE_NOTE_MAX_LENGTH"
                :disabled="saving"
                size="sm"
                class="w-full"
              />
            </div>
          </li>
        </ul>
      </UCard>

      <UCard>
        <USwitch
          v-model="form.agendaFinal"
          :disabled="saving"
          :label="t('calendar.agendaFinal')"
          :description="
            form.agendaFinal
              ? t('calendar.agendaFinalOn')
              : t('calendar.agendaFinalOff')
          "
        />
        <p
          v-if="assembly.agendaFinalizedAt && form.agendaFinal"
          class="text-muted mt-2 text-xs"
        >
          {{
            t("calendar.agendaFinalizedAt", {
              date: formatDateTime(assembly.agendaFinalizedAt, {
                locale,
              }),
            })
          }}
        </p>
      </UCard>

      <div
        class="bg-default/90 border-default sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-lg sm:border"
      >
        <span v-if="dirty" class="text-muted me-auto text-sm">
          {{ t("calendar.unsaved", { count: changeCount }, changeCount) }}
        </span>
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.discard')"
          :disabled="!dirty || saving"
          @click="discard"
        />
        <UButton
          type="submit"
          icon="i-lucide-save"
          :label="t('common.save')"
          :loading="saving"
          :disabled="!dirty"
        />
      </div>
    </form>

    <p class="sr-only" aria-live="polite" role="status">{{ announcement }}</p>

    <UModal
      v-model:open="defaultsConfirmOpen"
      :title="t('calendar.defaultsConfirmTitle')"
      :description="t('calendar.defaultsConfirmDescription')"
    >
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            @click="defaultsConfirmOpen = false"
          />
          <UButton
            :label="t('calendar.applyDefaults')"
            icon="i-lucide-wand-sparkles"
            @click="applyDefaults"
          />
        </div>
      </template>
    </UModal>

    <p class="text-muted text-sm">
      <ULink
        :to="sectionPath('convocatoria')"
        class="inline-flex items-center gap-1"
      >
        <UIcon name="i-lucide-scroll-text" class="size-4" aria-hidden="true" />
        {{ t("calendar.seeConvocation") }}
      </ULink>
    </p>
  </div>
</template>
