import { isProjectionPath } from "~/composables/shell/newVersion";

/**
 * When a new version of the platform is deployed while a page is open
 * (Nuxt's `app:manifest:update`, see app/composables/shell/newVersion.ts),
 * every page says so with a notice that stays until it is closed and offers
 * to reload: never a reload on its own, so nobody loses what they were
 * writing. The projection, shown to the room, reloads at once instead (it
 * reads everything again from the server: what is on screen, where the
 * Mesa has it scrolled).
 */
export default defineNuxtPlugin((nuxtApp) => {
  let handled = false;
  nuxtApp.hooks.hook("app:manifest:update", () => {
    if (handled) return;
    handled = true;
    const path = useRouter().currentRoute.value.path;
    if (isProjectionPath(path)) {
      void reloadNuxtApp({ force: true });
      return;
    }
    const t = nuxtApp.$i18n.t;
    useToast().add({
      id: "new-version",
      title: t("shell.newVersion.title"),
      description: t("shell.newVersion.description"),
      icon: "i-lucide-sparkles",
      color: "info",
      duration: Number.POSITIVE_INFINITY,
      actions: [
        {
          label: t("shell.newVersion.reload"),
          icon: "i-lucide-refresh-cw",
          onClick: () => {
            void reloadNuxtApp({ force: true });
          },
        },
      ],
    });
  });
});
