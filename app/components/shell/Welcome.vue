<script setup lang="ts">
import { welcomeAudience, welcomePending, welcomeSteps } from "./-welcome";

/**
 * The welcome: five short steps, one idea each, worded for what the
 * account can do (-welcome.ts), ending with the preferences. It opens by
 * itself the first time an account reaches the dashboard and again from
 * "Ayuda" in the sidebar.
 *
 * Closing it, at any step and however it closes, records that the account
 * saw it (POST /api/me/onboarding), so it never opens by itself again.
 * While an Admin acts as another account it neither opens by itself nor
 * records anything: "Ayuda" still shows what that account would read.
 *
 * Mounted client only by the layout, so nothing of it is server-rendered.
 */
const open = defineModel<boolean>("open", { default: false });

const { t } = useI18n();
const { me, member, refresh } = useMe();
const api = useApi();

const steps = computed(() =>
  welcomeSteps(
    welcomeAudience({
      isAdmin: me.value?.isAdmin ?? false,
      permissions: me.value?.permissions ?? [],
      role: me.value?.role ?? null,
      member: member.value,
    }),
  ),
);

const index = ref(0);
const step = computed(() => steps.value[index.value] ?? steps.value[0]);
const isFirst = computed(() => index.value === 0);
const isLast = computed(() => index.value === steps.value.length - 1);

function next(): void {
  if (isLast.value) open.value = false;
  else index.value += 1;
}
function back(): void {
  if (!isFirst.value) index.value -= 1;
}

/** Records the first close. A failure only means it opens again next time. */
let marking = false;
async function markSeen(): Promise<void> {
  if (marking || !welcomePending(me.value)) return;
  marking = true;
  try {
    await api.send("/api/me/onboarding", { method: "POST" });
    await refresh();
  } catch {
    // Nothing to tell the person: they did nothing wrong, and the welcome
    // simply shows again on their next visit.
  } finally {
    marking = false;
  }
}

watch(open, (isOpen, wasOpen) => {
  if (isOpen) index.value = 0;
  else if (wasOpen) void markSeen();
});

/** Opens by itself once per visit, as soon as the account is known. */
let offered = false;
onMounted(() => {
  watch(
    () => welcomePending(me.value),
    (pending) => {
      if (!pending || offered) return;
      offered = true;
      open.value = true;
    },
    { immediate: true },
  );
});
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('onboarding.title')"
    :description="
      t('onboarding.progress', { step: index + 1, total: steps.length })
    "
    :ui="{ content: 'sm:max-w-xl' }"
  >
    <template #body>
      <div v-if="step" class="space-y-5" aria-live="polite">
        <!-- The drawing of the step: decorative, the text says it all. -->
        <div
          class="bg-elevated flex items-center justify-center gap-5 rounded-xl py-8"
          aria-hidden="true"
        >
          <UIcon
            v-for="icon in step.icons"
            :key="icon"
            :name="icon"
            class="text-primary size-14 shrink-0"
          />
        </div>

        <div class="space-y-2">
          <h3 class="text-highlighted text-2xl font-semibold text-balance">
            {{ t(step.titleKey) }}
          </h3>
          <p class="text-default text-lg text-pretty">
            {{ t(step.bodyKey) }}
          </p>
          <p
            v-if="step.id === 'role' && me?.role"
            class="text-muted flex flex-wrap items-center gap-2 text-base"
          >
            {{ t("onboarding.yourRole") }}
            <ShellRoleBadge :role="me.role" size="md" />
            <span v-if="member">{{ member.acronym }}</span>
          </p>
        </div>

        <ShellPreferences v-if="step.id === 'preferences'" />
      </div>
    </template>

    <template #footer>
      <div class="flex w-full flex-col gap-4">
        <ol
          class="flex items-center justify-center gap-2"
          :aria-label="t('onboarding.stepsLabel')"
        >
          <li v-for="(item, position) in steps" :key="item.id" class="flex">
            <button
              type="button"
              class="focus-visible:outline-primary size-3 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2"
              :class="position === index ? 'bg-primary' : 'bg-accented'"
              :aria-label="t('onboarding.goToStep', { step: position + 1 })"
              :aria-current="position === index ? 'step' : undefined"
              @click="index = position"
            />
          </li>
        </ol>

        <div class="flex w-full flex-wrap items-center justify-between gap-2">
          <UButton
            v-if="!isLast"
            color="neutral"
            variant="ghost"
            size="lg"
            @click="open = false"
          >
            {{ t("onboarding.skip") }}
          </UButton>
          <span v-else />

          <div class="flex items-center gap-2">
            <UButton
              v-if="!isFirst"
              color="neutral"
              variant="soft"
              size="lg"
              icon="i-lucide-arrow-left"
              @click="back"
            >
              {{ t("onboarding.back") }}
            </UButton>
            <UButton
              size="lg"
              :trailing-icon="
                isLast ? 'i-lucide-check' : 'i-lucide-arrow-right'
              "
              @click="next"
            >
              {{ isLast ? t("onboarding.finish") : t("onboarding.next") }}
            </UButton>
          </div>
        </div>
      </div>
    </template>
  </UModal>
</template>
