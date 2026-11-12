<script setup lang="ts">
import { ONLINE_WINDOW_MINUTES } from "~~/shared/constants/online";

/**
 * An account's avatar in the admin lists (Usuarios, Estadísticas), with a
 * green dot while the account is online: it used the platform in the last
 * ONLINE_WINDOW_MINUTES (AdminUserDto.online, server/utils/live/online.ts).
 * The dot is not the only cue: screen readers hear "En línea" and the
 * pointer gets a tooltip that says what it means.
 */
const props = defineProps<{
  src?: string | null;
  alt: string;
  online?: boolean;
}>();

const { t } = useI18n();

const hint = computed(() =>
  t("admin.online.hint", { minutes: ONLINE_WINDOW_MINUTES }),
);
</script>

<template>
  <UTooltip v-if="props.online" :text="hint">
    <span class="inline-flex shrink-0">
      <UAvatar
        :src="props.src ?? undefined"
        :alt="props.alt"
        size="sm"
        :chip="{ color: 'success', position: 'bottom-right', inset: true }"
      />
      <span class="sr-only">{{ t("admin.online.label") }}</span>
    </span>
  </UTooltip>
  <UAvatar
    v-else
    :src="props.src ?? undefined"
    :alt="props.alt"
    size="sm"
    class="shrink-0"
  />
</template>
