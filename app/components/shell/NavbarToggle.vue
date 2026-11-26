<script setup lang="ts">
/**
 * The phone's menu button (hidden from lg, like Nuxt UI's own), for the
 * `#toggle` slot of every page's UDashboardNavbar: Nuxt UI's
 * UDashboardSidebarToggle with a dot (UChip) while the account has new
 * notices, the one sign of them always in view on a phone; «Avisos» itself
 * is in the drawer it opens. It is named for the menu in every state
 * («Abrir menú», «Cerrar menú») and, while there are new notices, says how
 * many after the same words: «Abrir menú, 3 avisos nuevos». The count is
 * read on the client only (useNotices), so the server and the first client
 * render show no dot and the name without a number.
 */
const { t } = useI18n();
const { unread } = useNotices();
const sidebarOpen = useShellSidebarOpen();

const count = computed(() => unread.value ?? 0);
const label = computed(() => {
  if (sidebarOpen.value) return t("shell.notices.closeMenu");
  return count.value > 0
    ? t("shell.notices.openMenuNew", { count: count.value }, count.value)
    : t("shell.notices.openMenu");
});
</script>

<template>
  <UChip
    :show="count > 0"
    color="primary"
    size="md"
    inset
    class="lg:hidden"
    data-testid="navbar-toggle"
  >
    <UDashboardSidebarToggle :aria-label="label" />
  </UChip>
</template>
