/**
 * Whether the sidebar's drawer is open on a phone: the default layout's
 * `v-model:open` of UDashboardSidebar, shared so the menu button
 * (ShellNavbarToggle) names itself for what it does, and the layout closes
 * the drawer before «Avisos» opens over the page.
 */
export function useShellSidebarOpen() {
  return useState<boolean>("shell-sidebar-open", () => false);
}
