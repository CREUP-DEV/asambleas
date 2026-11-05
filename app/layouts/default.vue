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
 * never covers the navbars.
 */
const { t } = useI18n();
const bannerOffset = useImpersonationBannerOffset();

const sidebarOpen = ref(false);

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
      :style="bannerOffset !== '0px' ? { top: bannerOffset } : undefined"
    >
      <!-- The banner landmark holds the brand, the navigation and the user
           menu (preferences, language, sign out). On phones the drawer is a
           dialog instead. -->
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

            <div class="mt-auto hidden pt-2 lg:flex">
              <UDashboardSidebarCollapse :class="collapsed ? 'mx-auto' : ''" />
            </div>
          </div>
        </template>

        <template #footer="{ collapsed }">
          <ShellUserMenu :collapsed="collapsed" />
        </template>
      </UDashboardSidebar>

      <!--
        Panels fill <main> and scroll their own body. The overflow is a
        safety net for pages that render plain content instead of a panel.
      -->
      <main
        id="main-content"
        tabindex="-1"
        class="flex min-w-0 flex-1 overflow-y-auto focus:outline-none print:block print:overflow-visible"
      >
        <slot />
      </main>
    </UDashboardGroup>

    <ShellSessionBanner class="print:hidden" />
  </div>
</template>
