<script setup lang="ts">
import {
  ASSEMBLY_STATUSES,
  ASSEMBLY_STATUS_TRANSITIONS,
  type AssemblyStatus,
} from "~~/shared/constants/domain";
import type { AssemblyDto } from "~~/shared/types/api";

/**
 * The assembly's status changes (assembly:manage), each asked before it is
 * done, in the section they belong to: opening, suspending, closing and
 * reopening the session in «Sesión», convening and going back to draft in
 * «Convocatoria», and all of them in «Ajustes». `only` keeps the changes
 * named there ("convened_in_session": from convened to in session); nothing
 * shows when none applies from the current status. Forward changes are buttons; going back
 * («Volver a borrador», «Suspender sesión») is quieter.
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
  const value = assembly.value;
  if (!transition || !value) return;
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
    confirmOpen.value = false;
    statusMessage.value = t(`assembly.transitions.${transition.key}.done`);
    toast.add({
      title: statusMessage.value,
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (failure) {
    api.notifyError(failure, "assembly.hub.statusError");
    if (api.isConflict(failure)) {
      confirmOpen.value = false;
      await refresh();
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="transitions.length > 0" class="flex flex-wrap items-center gap-2">
    <UButton
      v-for="transition in transitions"
      :key="transition.key"
      v-bind="buttonStyle(transition)"
      :size="size"
      :icon="
        transition.forward ? 'i-lucide-arrow-right-circle' : 'i-lucide-undo-2'
      "
      :label="t(`assembly.transitions.${transition.key}.label`)"
      @click="ask(transition)"
    />
    <p class="sr-only" aria-live="polite" role="status">
      {{ statusMessage }}
    </p>

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
