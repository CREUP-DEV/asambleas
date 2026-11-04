<script lang="ts">
import { SYSTEM_ROLES } from "~~/shared/constants/roles";

const ROLE_KEYS: Record<string, string> = {
  [SYSTEM_ROLES.ADMIN]: "shell.roles.admin",
  [SYSTEM_ROLES.SECRETARIA]: "shell.roles.secretaria",
  [SYSTEM_ROLES.MODERADOR]: "shell.roles.moderador",
  [SYSTEM_ROLES.ASOCIADO]: "shell.roles.asociado",
  [SYSTEM_ROLES.INVITADO]: "shell.roles.invitado",
};

/**
 * i18n key of a system role name ("Secretaría" -> "shell.roles.secretaria"),
 * or null for custom roles, which are shown as stored.
 */
export function roleLabelKey(name: string | null | undefined): string | null {
  return name ? (ROLE_KEYS[name] ?? null) : null;
}
</script>

<script setup lang="ts">
/** A platform role as a badge, translated for system roles. */
const props = withDefaults(
  defineProps<{
    role: string | null | undefined;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
  }>(),
  { size: "sm" },
);

const { t } = useI18n();

const label = computed(() => {
  const key = roleLabelKey(props.role);
  if (key) return t(key);
  return props.role || t("shell.roles.none");
});

const color = computed(() =>
  props.role === SYSTEM_ROLES.ADMIN
    ? "primary"
    : props.role === SYSTEM_ROLES.SECRETARIA ||
        props.role === SYSTEM_ROLES.MODERADOR
      ? "secondary"
      : "neutral",
);
</script>

<template>
  <UBadge :color="color" variant="subtle" :size="size" :label="label" />
</template>
