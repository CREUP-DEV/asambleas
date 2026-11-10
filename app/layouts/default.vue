<script setup lang="ts">
import { useImpersonationBannerOffset } from "~/components/shell/ImpersonationBanner.vue";

/**
 * Authenticated dashboard shell. Every page renders its own UDashboardPanel
 * (with a UDashboardNavbar in #header, which carries the mobile sidebar
 * toggle) directly inside <main>, so pages can lay out sibling resizable
 * panels. Chrome-free pages (projection, print) use `layout: false`.
 *
 * The dashboard is fixed to the viewport; while an Admin acts as another
 * account it starts below the impersonation banner (app.vue), so the banner
 * never covers the navbars, and `--shell-banner-height` tells the pages
 * sized to the viewport how much to take off.
 *
 * It also holds the welcome (ShellWelcome), which opens by itself on an
 * account's first visit, and "Ayuda" in the sidebar footer, which opens it
 * again. The welcome is client only: nothing of it is server-rendered.
 */
const { t } = useI18n();
const bannerOffset = useImpersonationBannerOffset();

const sidebarOpen = ref(false);
const welcomeOpen = ref(false);

/** On phones the sidebar is a drawer: it closes so the welcome is on top. */
function openHelp(): void {
  sidebarOpen.value = false;
  welcomeOpen.value = true;
}

useHead({
  titleTemplate: (titleChunk) =>
    titleChunk ? `${titleChunk} | ${t("shell.appName")}` : t("shell.appName"),
});
</script>

<template>
  <div>
    <a
      href="#main-navigation"
      class="bg-primary text-inverted sr-only rounded-md px-4 py-2 focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50"
    >
      {{ t("shell.skipToNavigation") }}
    </a>
    <a
      href="#main-content"
      class="bg-primary text-inverted sr-only rounded-md px-4 py-2 focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50"
    >
      {{ t("shell.skipToContent") }}
    </a>

    <UDashboardGroup
      class="print:static print:block print:overflow-visible"
      :style="
        bannerOffset !== '0px'
          ? { top: bannerOffset, '--shell-banner-height': bannerOffset }
          : undefined
      "
    >
      <!-- The banner landmark holds the brand, the navigation, "Ayuda" and
           the user menu (activity, preferences, sign out). On phones the
           drawer is a dialog instead. -->
      <UDashboardSidebar
        id="main"
        v-model:open="sidebarOpen"
        role="banner"
        collapsible
        resizable
        :default-size="18"
        :min-size="14"
        :max-size="26"
        class="print:hidden"
        :ui="{ footer: 'lg:border-t lg:border-default' }"
      >
        <template #header="{ collapsed }">
          <ShellBrand :collapsed="collapsed" />
        </template>

        <template #default="{ collapsed }">
          <div
            id="main-navigation"
            tabindex="-1"
            class="flex flex-1 flex-col gap-2 focus:outline-none"
          >
            <ShellNavigation :collapsed="collapsed" />
          </div>
        </template>

        <template #footer="{ collapsed }">
          <div class="flex w-full min-w-0 flex-col gap-1">
            <UTooltip
              :text="t('shell.help.open')"
              :disabled="!collapsed"
              :content="{ side: 'right' }"
            >
              <UButton
                color="neutral"
                variant="ghost"
                icon="i-lucide-life-buoy"
                :block="!collapsed"
                :square="collapsed"
                :label="collapsed ? undefined : t('shell.help.open')"
                :aria-label="t('shell.help.label')"
                class="justify-start gap-2.5"
                :class="collapsed ? 'justify-center' : ''"
                @click="openHelp"
              />
            </UTooltip>
            <ShellUserMenu :collapsed="collapsed" />
          </div>
        </template>
      </UDashboardSidebar>

      <!--
        Panels fill <main> and scroll their own body. The overflow is a
        safety net for pages that render plain content instead of a panel.
        Each panel shows the breadcrumb row (ShellBreadcrumbs) under its
        navbar; its height is set here, so the row and the pages that size
        themselves to the viewport agree on it.
      -->
      <main
        id="main-content"
        tabindex="-1"
        class="flex min-w-0 flex-1 overflow-y-auto [--shell-breadcrumb-height:2.5rem] focus:outline-none print:block print:overflow-visible"
      >
        <slot />
      </main>
    </UDashboardGroup>

    <ShellSessionBanner class="print:hidden" />

    <ClientOnly>
      <ShellWelcome v-model:open="welcomeOpen" />
    </ClientOnly>
  </div>
</template>
