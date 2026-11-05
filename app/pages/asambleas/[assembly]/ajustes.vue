<script setup lang="ts">
import { z } from "zod/v4";
import type { FormSubmitEvent } from "@nuxt/ui";
import {
  ALL_ASSEMBLY_TYPES,
  type AssemblyType,
} from "~~/shared/constants/assemblyTypes";
import {
  DEFAULT_ASSEMBLY_SETTINGS,
  type AssemblySettings,
} from "~~/shared/constants/domain";
import type { AssemblyDto, AssemblyUpdateBody } from "~~/shared/types/api";
import { ASSEMBLY_LOCATION_MAX_LENGTH } from "~~/shared/utils/schemas/assembly";

/**
 * Assembly settings: basic data (number, type, dates, place), the
 * per-assembly policies with an explanation of each, and deletion while the
 * assembly is a draft. Managers only.
 */

const { t } = useI18n();
const toast = useToast();
const api = useApi();
const localePath = useLocalePath();
const current = useCurrentAssembly();
const { assembly, sectionPath } = current;

useHead({
  title: () =>
    [t("assembly.settingsPage.title"), assembly.value?.label]
      .filter(Boolean)
      .join(" · "),
});

// Basic data -------------------------------------------------------------------

const basicsSchema = computed(() =>
  z
    .object({
      number: z
        .number(t("assembly.basics.numberInvalid"))
        .int(t("assembly.basics.numberInvalid"))
        .min(1, t("assembly.basics.numberInvalid"))
        .max(9_999, t("assembly.basics.numberInvalid")),
      type: z.enum(ALL_ASSEMBLY_TYPES as [AssemblyType, ...AssemblyType[]]),
      startDate: z
        .string()
        .nullable()
        .refine((value) => Boolean(value), t("assembly.basics.dateRequired")),
      endDate: z
        .string()
        .nullable()
        .refine((value) => Boolean(value), t("assembly.basics.dateRequired")),
      location: z
        .string()
        .trim()
        .min(1, t("assembly.basics.locationRequired"))
        .max(
          ASSEMBLY_LOCATION_MAX_LENGTH,
          t("assembly.basics.tooLong", { max: ASSEMBLY_LOCATION_MAX_LENGTH }),
        ),
    })
    .refine(
      (value) =>
        !value.startDate ||
        !value.endDate ||
        new Date(value.endDate) >= new Date(value.startDate),
      { message: t("assembly.basics.endBeforeStart"), path: ["endDate"] },
    ),
);

interface BasicsForm {
  number: number | undefined;
  type: AssemblyType;
  startDate: string | null;
  endDate: string | null;
  location: string;
}

function basicsFrom(value: AssemblyDto | null): BasicsForm {
  return {
    number: value?.number,
    type: value?.type ?? "AGO",
    startDate: value?.startDate ?? null,
    endDate: value?.endDate ?? null,
    location: value?.location ?? "",
  };
}

const basics = reactive<BasicsForm>(basicsFrom(assembly.value));
const savingBasics = ref(false);

const basicsDirty = computed(() => {
  const value = assembly.value;
  if (!value) return false;
  const sameDate = (a: string | null, b: string) =>
    Boolean(a) && new Date(a!).getTime() === new Date(b).getTime();
  return (
    basics.number !== value.number ||
    basics.type !== value.type ||
    !sameDate(basics.startDate, value.startDate) ||
    !sameDate(basics.endDate, value.endDate) ||
    basics.location.trim() !== value.location
  );
});

const startMoved = computed(() => {
  const value = assembly.value;
  return Boolean(
    value &&
    basics.startDate &&
    new Date(basics.startDate).getTime() !==
      new Date(value.startDate).getTime(),
  );
});

const typeItems = computed(() =>
  ALL_ASSEMBLY_TYPES.map((type) => ({
    label: `${type} · ${t(`assembly.types.${type}`)}`,
    value: type,
  })),
);

type BasicsOutput = z.output<typeof basicsSchema.value>;

async function saveBasics(event: FormSubmitEvent<BasicsOutput>) {
  const value = assembly.value;
  if (!value) return;
  const data = event.data;
  const body: AssemblyUpdateBody = {
    number: data.number,
    type: data.type,
    startDate: data.startDate ?? undefined,
    endDate: data.endDate ?? undefined,
    location: data.location,
    updatedAt: value.updatedAt,
  };
  savingBasics.value = true;
  try {
    const updated = await api.send<AssemblyDto>(current.apiBase.value, {
      method: "PUT",
      body,
    });
    const slugChanged = updated.slug !== value.slug;
    current.setAssembly(updated);
    Object.assign(basics, basicsFrom(updated));
    toast.add({
      title: t("assembly.basics.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
    if (slugChanged) {
      await navigateTo(localePath(`/asambleas/${updated.slug}/ajustes`), {
        replace: true,
      });
    }
  } catch (error) {
    api.notifyError(error, "assembly.basics.saveError");
    if (api.isConflict(error)) await current.refresh();
  } finally {
    savingBasics.value = false;
  }
}

function resetBasics() {
  Object.assign(basics, basicsFrom(assembly.value));
}

// Settings ---------------------------------------------------------------------

type SettingKey = keyof AssemblySettings;

// Whether accepted amendments are voted or incorporated is no longer an
// assembly policy: each document decides it (its advanced options).
const SETTING_OPTIONS: { [K in SettingKey]: AssemblySettings[K][] } = {
  positionVisibility: ["mesa", "session", "public"],
  tieRule: ["rejected", "repeat"],
  denominator: ["valid_votes", "present"],
};
const SETTING_KEYS = Object.keys(SETTING_OPTIONS) as SettingKey[];

/**
 * The stored policies over the defaults, keeping only the ones this page
 * edits: older assemblies may still store policies that are gone.
 */
function settingsFrom(value: AssemblyDto | null): AssemblySettings {
  const merged: AssemblySettings = {
    ...DEFAULT_ASSEMBLY_SETTINGS,
    ...(value?.settings ?? {}),
  };
  return Object.fromEntries(
    SETTING_KEYS.map((key) => [key, merged[key]]),
  ) as unknown as AssemblySettings;
}

const settings = reactive<AssemblySettings>(settingsFrom(assembly.value));
const savingSettings = ref(false);

const changedSettings = computed(() => {
  const stored = settingsFrom(assembly.value);
  return SETTING_KEYS.filter((key) => settings[key] !== stored[key]);
});

function settingItems(key: SettingKey) {
  return SETTING_OPTIONS[key].map((option) => ({
    value: option,
    label: t(`assembly.settings.${key}.options.${option}.label`),
    description: t(`assembly.settings.${key}.options.${option}.description`),
  }));
}

function setSetting(key: SettingKey, value: unknown) {
  const options = SETTING_OPTIONS[key] as readonly unknown[];
  if (options.includes(value)) {
    (settings as Record<SettingKey, unknown>)[key] = value;
  }
}

function isDefault(key: SettingKey): boolean {
  return settings[key] === DEFAULT_ASSEMBLY_SETTINGS[key];
}

async function saveSettings() {
  const value = assembly.value;
  if (!value || changedSettings.value.length === 0) return;
  const patch = Object.fromEntries(
    changedSettings.value.map((key) => [key, settings[key]]),
  ) as Partial<AssemblySettings>;
  savingSettings.value = true;
  try {
    const updated = await api.send<AssemblyDto>(current.apiBase.value, {
      method: "PUT",
      body: { settings: patch, updatedAt: value.updatedAt },
    });
    current.setAssembly(updated);
    Object.assign(settings, settingsFrom(updated));
    toast.add({
      title: t("assembly.settings.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    api.notifyError(error, "assembly.settings.saveError");
    if (api.isConflict(error)) await current.refresh();
  } finally {
    savingSettings.value = false;
  }
}

function resetSettings() {
  Object.assign(settings, settingsFrom(assembly.value));
}

// Remote changes: refresh untouched forms.
watch(assembly, (value, previous) => {
  if (!value || value.updatedAt === previous?.updatedAt) return;
  if (!basicsDirty.value && !savingBasics.value) {
    Object.assign(basics, basicsFrom(value));
  }
  if (changedSettings.value.length === 0 && !savingSettings.value) {
    Object.assign(settings, settingsFrom(value));
  }
});

// Delete -----------------------------------------------------------------------

const deleteOpen = ref(false);
const deleting = ref(false);
const deleteConfirmText = ref("");
const deleteMatches = computed(
  () =>
    deleteConfirmText.value.trim().toLowerCase() ===
    (assembly.value?.label ?? "").toLowerCase(),
);

watch(deleteOpen, (open) => {
  if (open) deleteConfirmText.value = "";
});

async function confirmDelete() {
  const value = assembly.value;
  if (!value || !deleteMatches.value) return;
  deleting.value = true;
  try {
    await api.send(current.apiBase.value, { method: "DELETE" });
    deleteOpen.value = false;
    toast.add({
      id: "assembly-deleted",
      title: t("assembly.danger.deleted", { label: value.label }),
      color: "success",
      icon: "i-lucide-trash-2",
    });
    await navigateTo(localePath("/asambleas"));
  } catch (error) {
    api.notifyError(error, "assembly.danger.deleteError");
    if (api.isConflict(error)) await current.refresh();
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div v-if="assembly" class="space-y-6">
    <CommonEmptyState
      v-if="!assembly.can.manage"
      icon="i-lucide-shield-x"
      :title="t('assembly.settingsPage.forbiddenTitle')"
      :description="t('assembly.settingsPage.forbiddenDescription')"
      variant="outline"
    >
      <template #action>
        <UButton
          color="neutral"
          variant="outline"
          icon="i-lucide-arrow-left"
          :label="t('assembly.settingsPage.backToOverview')"
          :to="sectionPath()"
        />
      </template>
    </CommonEmptyState>

    <template v-else>
      <div class="space-y-1">
        <h2 class="text-highlighted text-xl font-semibold">
          {{ t("assembly.settingsPage.title") }}
        </h2>
        <p class="text-muted text-sm">
          {{ t("assembly.settingsPage.intro") }}
        </p>
      </div>

      <!-- Basic data -->
      <UCard as="section" aria-labelledby="settings-basics-title">
        <template #header>
          <h3 id="settings-basics-title" class="text-highlighted font-semibold">
            {{ t("assembly.basics.title") }}
          </h3>
        </template>
        <UForm
          id="assembly-basics-form"
          :schema="basicsSchema"
          :state="basics"
          class="grid gap-4 sm:grid-cols-2"
          @submit="saveBasics"
        >
          <UFormField
            :label="t('assembly.basics.number')"
            name="number"
            required
          >
            <UInputNumber
              v-model="basics.number"
              :min="1"
              :max="9999"
              :disabled="savingBasics"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('assembly.basics.type')" name="type" required>
            <USelect
              v-model="basics.type"
              :items="typeItems"
              value-key="value"
              :disabled="savingBasics"
              class="w-full"
            />
          </UFormField>
          <UFormField
            :label="t('assembly.basics.startDate')"
            :hint="t('assembly.basics.timeZone')"
            name="startDate"
            required
          >
            <CalendarDateTimeInput
              v-model="basics.startDate"
              :aria-label="t('assembly.basics.startDate')"
              :disabled="savingBasics"
              required
            />
          </UFormField>
          <UFormField
            :label="t('assembly.basics.endDate')"
            :hint="t('assembly.basics.timeZone')"
            name="endDate"
            required
          >
            <CalendarDateTimeInput
              v-model="basics.endDate"
              :aria-label="t('assembly.basics.endDate')"
              :disabled="savingBasics"
              required
            />
          </UFormField>
          <UFormField
            :label="t('assembly.basics.location')"
            name="location"
            required
            class="sm:col-span-2"
          >
            <UInput
              v-model="basics.location"
              :maxlength="ASSEMBLY_LOCATION_MAX_LENGTH"
              :disabled="savingBasics"
              class="w-full"
            />
          </UFormField>
          <UAlert
            v-if="startMoved"
            class="sm:col-span-2"
            color="info"
            variant="subtle"
            icon="i-lucide-calendar-clock"
            :title="t('assembly.basics.startMoved')"
            :actions="[
              {
                label: t('assembly.basics.reviewCalendar'),
                to: sectionPath('calendario'),
                color: 'info',
                variant: 'link',
                trailingIcon: 'i-lucide-arrow-right',
              },
            ]"
          />
          <UAlert
            v-if="
              basics.number !== assembly.number || basics.type !== assembly.type
            "
            class="sm:col-span-2"
            color="warning"
            variant="subtle"
            icon="i-lucide-link"
            :title="t('assembly.basics.slugChanges')"
          />
        </UForm>
        <template #footer>
          <div class="flex flex-wrap justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              :label="t('common.discard')"
              :disabled="!basicsDirty || savingBasics"
              @click="resetBasics"
            />
            <UButton
              type="submit"
              form="assembly-basics-form"
              icon="i-lucide-save"
              :label="t('common.save')"
              :loading="savingBasics"
              :disabled="!basicsDirty"
            />
          </div>
        </template>
      </UCard>

      <!-- Policies -->
      <UCard as="section" aria-labelledby="settings-policies-title">
        <template #header>
          <div class="space-y-1">
            <h3
              id="settings-policies-title"
              class="text-highlighted font-semibold"
            >
              {{ t("assembly.settings.title") }}
            </h3>
            <p class="text-muted text-sm">
              {{ t("assembly.settings.intro") }}
            </p>
          </div>
        </template>
        <form
          id="assembly-settings-form"
          class="divide-default space-y-0 divide-y"
          @submit.prevent="saveSettings"
        >
          <div
            v-for="key in SETTING_KEYS"
            :key="key"
            class="grid gap-3 py-5 first:pt-0 last:pb-0 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
          >
            <div class="space-y-1">
              <p
                :id="`setting-${key}-label`"
                class="text-highlighted flex flex-wrap items-center gap-2 font-medium"
              >
                {{ t(`assembly.settings.${key}.label`) }}
                <UBadge
                  v-if="isDefault(key)"
                  color="neutral"
                  variant="soft"
                  size="sm"
                  :label="t('assembly.settings.default')"
                />
                <UBadge
                  v-if="changedSettings.includes(key)"
                  color="info"
                  variant="soft"
                  size="sm"
                  :label="t('assembly.settings.changed')"
                />
              </p>
              <p :id="`setting-${key}-help`" class="text-muted text-sm">
                {{ t(`assembly.settings.${key}.help`) }}
              </p>
            </div>
            <URadioGroup
              :model-value="settings[key]"
              :items="settingItems(key)"
              value-key="value"
              variant="card"
              :disabled="savingSettings"
              :aria-labelledby="`setting-${key}-label`"
              :aria-describedby="`setting-${key}-help`"
              @update:model-value="setSetting(key, $event)"
            />
          </div>
        </form>
        <p
          class="text-muted border-default mt-5 flex items-start gap-1.5 border-t pt-5 text-sm"
        >
          <UIcon
            name="i-lucide-info"
            class="mt-0.5 size-4 shrink-0"
            aria-hidden="true"
          />
          <span>{{ t("assembly.settings.acceptedPerDocument") }}</span>
        </p>
        <template #footer>
          <div class="flex flex-wrap justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              :label="t('common.discard')"
              :disabled="changedSettings.length === 0 || savingSettings"
              @click="resetSettings"
            />
            <UButton
              type="submit"
              form="assembly-settings-form"
              icon="i-lucide-save"
              :label="t('common.save')"
              :loading="savingSettings"
              :disabled="changedSettings.length === 0"
            />
          </div>
        </template>
      </UCard>

      <!-- Danger zone -->
      <UCard
        as="section"
        aria-labelledby="settings-danger-title"
        :ui="{ root: 'ring-error/40' }"
      >
        <template #header>
          <h3 id="settings-danger-title" class="text-error font-semibold">
            {{ t("assembly.danger.title") }}
          </h3>
        </template>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="text-muted max-w-prose text-sm">
            {{
              assembly.status === "draft"
                ? t("assembly.danger.description")
                : t("assembly.danger.onlyDraft")
            }}
          </p>
          <UButton
            color="error"
            variant="outline"
            icon="i-lucide-trash-2"
            :label="t('assembly.danger.delete')"
            :disabled="assembly.status !== 'draft'"
            @click="deleteOpen = true"
          />
        </div>
      </UCard>

      <UModal
        v-model:open="deleteOpen"
        :title="t('assembly.danger.confirmTitle', { label: assembly.label })"
        :description="t('assembly.danger.confirmDescription')"
        :dismissible="!deleting"
      >
        <template #body>
          <form id="assembly-delete-form" @submit.prevent="confirmDelete">
            <UFormField
              :label="t('assembly.danger.typeLabel', { label: assembly.label })"
            >
              <UInput
                v-model="deleteConfirmText"
                autocomplete="off"
                :placeholder="assembly.label"
                class="w-full"
              />
            </UFormField>
          </form>
        </template>
        <template #footer>
          <div class="flex w-full flex-wrap justify-end gap-2">
            <UButton
              color="neutral"
              variant="outline"
              :label="t('common.cancel')"
              :disabled="deleting"
              @click="deleteOpen = false"
            />
            <UButton
              type="submit"
              form="assembly-delete-form"
              color="error"
              icon="i-lucide-trash-2"
              :label="t('assembly.danger.delete')"
              :loading="deleting"
              :disabled="!deleteMatches"
            />
          </div>
        </template>
      </UModal>
    </template>
  </div>
</template>
