<script setup lang="ts">
import {
  ASSEMBLY_STATUSES,
  ASSEMBLY_STATUS_TRANSITIONS,
  type AssemblyStatus,
} from "~~/shared/constants/domain";
import type { AssemblyDto } from "~~/shared/types/api";
import { defaultAdjournChoice } from "~/utils/adjourn";

/**
 * The assembly's status changes (assembly:manage), each asked before it is
 * done, in the section they belong to: opening, suspending, closing and
 * reopening the session in «Sesión», convening and going back to draft in
 * «Convocatoria», and all of them in «Ajustes». `only` keeps the changes
 * named there ("convened_in_session": from convened to in session); nothing
 * shows when none applies from the current status. Forward changes are buttons; going back
 * («Volver a borrador») is quieter.
 *
 * Leaving a session in progress is one button, «Levantar la sesión» (user's
 * decision of 2026-11-18), whenever both ways out are offered: its dialog
 * asks whether the session resumes later (back to convened) or the
 * assembly finishes (closed), and starts on the second when the
 * assembly's configured end is less than an hour away or past
 * (defaultAdjournChoice).
 */
const props = withDefaults(
  defineProps<{
    /** The changes this place offers, as "from_to"; every one without it. */
    only?: readonly string[];
    size?: "sm" | "md";
  }>(),
  { only: undefined, size: "md" },
);

interface TransitionAction {
  to: AssemblyStatus;
  key: string;
  forward: boolean;
}

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const { assembly, setAssembly, refresh } = useCurrentAssembly();

/** The two ways out of a session in progress, merged into one button. */
const RESUME_KEY = "in_session_convened";
const FINISH_KEY = "in_session_closed";

const transitions = computed<TransitionAction[]>(() => {
  const value = assembly.value;
  if (!value?.can.manage) return [];
  const rank = (status: AssemblyStatus) => ASSEMBLY_STATUSES.indexOf(status);
  return ASSEMBLY_STATUS_TRANSITIONS[value.status]
    .map((to) => ({
      to,
      key: `${value.status}_${to}`,
      forward: rank(to) > rank(value.status),
    }))
    .filter((transition) => !props.only || props.only.includes(transition.key));
});

/** Both ways out of the session: one «Levantar la sesión» asks which. */
const adjourn = computed(() => {
  const resume = transitions.value.find((entry) => entry.key === RESUME_KEY);
  const finish = transitions.value.find((entry) => entry.key === FINISH_KEY);
  return resume && finish ? { resume, finish } : null;
});
/** The buttons: every change but the two «Levantar la sesión» stands for. */
const shown = computed(() =>
  adjourn.value
    ? transitions.value.filter(
        (entry) => entry.key !== RESUME_KEY && entry.key !== FINISH_KEY,
      )
    : transitions.value,
);
const adjournOpen = ref(false);
const adjournChoice = ref<"resume" | "finish">("resume");
const adjournItems = computed(() => [
  {
    value: "resume",
    label: t("assembly.adjourn.resume"),
    description: t(`assembly.transitions.${RESUME_KEY}.description`, {
      label: assembly.value?.label ?? "",
    }),
  },
  {
    value: "finish",
    label: t("assembly.adjourn.finish"),
    description: t(`assembly.transitions.${FINISH_KEY}.description`, {
      label: assembly.value?.label ?? "",
    }),
  },
]);
function askAdjourn(): void {
  adjournChoice.value = defaultAdjournChoice(assembly.value?.endDate);
  adjournOpen.value = true;
}
async function confirmAdjourn(): Promise<void> {
  const choice = adjourn.value?.[adjournChoice.value];
  if (!choice) return;
  if (await apply(choice)) adjournOpen.value = false;
}

/**
 * Tinted, not solid, so they never compete with the section's own main
 * action; closing the assembly is never the most prominent button.
 */
function buttonStyle(transition: TransitionAction) {
  if (!transition.forward) {
    return { color: "neutral" as const, variant: "ghost" as const };
  }
  return transition.key === "in_session_closed"
    ? { color: "neutral" as const, variant: "outline" as const }
    : { color: "primary" as const, variant: "soft" as const };
}

/**
 * Each change's icon: adjourning the session pauses it until it reopens,
 * finishing the assembly is its end; the others move forward or back.
 */
const TRANSITION_ICONS: Record<string, string> = {
  in_session_convened: "i-lucide-circle-pause",
  in_session_closed: "i-lucide-flag",
};
function iconOf(transition: TransitionAction): string {
  return (
    TRANSITION_ICONS[transition.key] ??
    (transition.forward ? "i-lucide-arrow-right-circle" : "i-lucide-undo-2")
  );
}

const pending = ref<TransitionAction | null>(null);
const confirmOpen = ref(false);
const busy = ref(false);
const statusMessage = ref("");

function ask(transition: TransitionAction) {
  pending.value = transition;
  confirmOpen.value = true;
}

async function confirm() {
  const transition = pending.value;
  if (transition && (await apply(transition))) confirmOpen.value = false;
}

/** Sends a change of status; true once done. */
async function apply(transition: TransitionAction): Promise<boolean> {
  const value = assembly.value;
  if (!value) return false;
  busy.value = true;
  try {
    const updated = await api.send<AssemblyDto>(
      `/api/assemblies/${value.id}/status`,
      {
        method: "PUT",
        body: { status: transition.to, updatedAt: value.updatedAt },
      },
    );
    setAssembly(updated);
    statusMessage.value = t(`assembly.transitions.${transition.key}.done`);
    toast.add({
      title: statusMessage.value,
      color: "success",
      icon: "i-lucide-check",
    });
    return true;
  } catch (failure) {
    api.notifyError(failure, "assembly.hub.statusError");
    if (api.isConflict(failure)) {
      confirmOpen.value = false;
      adjournOpen.value = false;
      await refresh();
    }
    return false;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="transitions.length > 0" class="flex flex-wrap items-center gap-2">
    <UButton
      v-if="adjourn"
      color="neutral"
      variant="outline"
      :size="size"
      icon="i-lucide-circle-pause"
      :label="t('assembly.adjourn.button')"
      @click="askAdjourn"
    />
    <UButton
      v-for="transition in shown"
      :key="transition.key"
      v-bind="buttonStyle(transition)"
      :size="size"
      :icon="iconOf(transition)"
      :label="t(`assembly.transitions.${transition.key}.label`)"
      @click="ask(transition)"
    />
    <p class="sr-only" aria-live="polite" role="status">
      {{ statusMessage }}
    </p>

    <UModal
      v-model:open="adjournOpen"
      :title="t('assembly.adjourn.title')"
      :description="t('assembly.adjourn.description')"
      :dismissible="!busy"
    >
      <template #body>
        <URadioGroup
          v-model="adjournChoice"
          :items="adjournItems"
          variant="card"
          :legend="t('assembly.adjourn.legend')"
        />
      </template>
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="busy"
            @click="adjournOpen = false"
          />
          <UButton
            :color="adjournChoice === 'finish' ? 'warning' : 'primary'"
            :icon="
              adjournChoice === 'finish'
                ? 'i-lucide-flag'
                : 'i-lucide-circle-pause'
            "
            :label="
              adjournChoice === 'finish'
                ? t('assembly.adjourn.confirmFinish')
                : t('assembly.adjourn.confirmResume')
            "
            :loading="busy"
            @click="confirmAdjourn"
          />
        </div>
      </template>
    </UModal>

    <UModal
      v-model:open="confirmOpen"
      :title="pending ? t(`assembly.transitions.${pending.key}.title`) : ''"
      :description="
        pending && assembly
          ? t(`assembly.transitions.${pending.key}.description`, {
              label: assembly.label,
            })
          : ''
      "
      :dismissible="!busy"
    >
      <template #footer>
        <div class="flex w-full flex-wrap justify-end gap-2">
          <UButton
            color="neutral"
            variant="outline"
            :label="t('common.cancel')"
            :disabled="busy"
            @click="confirmOpen = false"
          />
          <UButton
            v-if="pending"
            :color="pending.forward ? 'primary' : 'warning'"
            :label="t(`assembly.transitions.${pending.key}.label`)"
            :loading="busy"
            @click="confirm"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
