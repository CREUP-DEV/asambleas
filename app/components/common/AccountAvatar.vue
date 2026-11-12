<script setup lang="ts">
import { ONLINE_WINDOW_MINUTES } from "~~/shared/constants/online";
import { avatarDisplayText, avatarTextClass } from "~/utils/accountAvatar";

/**
 * An account's avatar: its photo or, without one, the text the server
 * worked out (`avatarText`, accountAvatarText: the university's acronym or
 * the member's), else the initials of its name. Longer acronyms get a
 * smaller type so they fit in the circle (avatarTextClass), and one too
 * long to read there gives way to the initials (avatarDisplayText).
 *
 * In the admin lists (Usuarios, Estadísticas) it carries a green dot while
 * the account is online: it used the platform in the last
 * ONLINE_WINDOW_MINUTES (AdminUserDto.online, server/utils/live/online.ts).
 * The dot is not the only cue: screen readers hear "En línea" and the
 * pointer gets a tooltip that says what it means.
 */
const props = withDefaults(
  defineProps<{
    src?: string | null;
    alt: string;
    text?: string | null;
    online?: boolean;
    size?: "sm" | "md";
  }>(),
  { src: null, text: null, online: false, size: "sm" },
);

const { t } = useI18n();

const hint = computed(() =>
  t("admin.online.hint", { minutes: ONLINE_WINDOW_MINUTES }),
);

const avatar = computed(() => ({
  src: props.src ?? undefined,
  alt: props.alt,
  text: avatarDisplayText(props.text),
  size: props.size,
  ui: { fallback: avatarTextClass(props.text, props.size) },
}));
</script>

<template>
  <UTooltip v-if="props.online" :text="hint">
    <span class="inline-flex shrink-0">
      <UAvatar
        v-bind="avatar"
        :chip="{ color: 'success', position: 'bottom-right', inset: true }"
      />
      <span class="sr-only">{{ t("admin.online.label") }}</span>
    </span>
  </UTooltip>
  <UAvatar v-else v-bind="avatar" class="shrink-0" />
</template>
