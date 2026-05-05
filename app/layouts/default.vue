<script setup lang="ts">
const { t } = useI18n();
const localePath = useLocalePath();
const { session, signOut } = useAuth();
const { isAdmin } = usePermissions();
const { currentLocale, localeMenuItems } = useLocaleSwitcher();

const avatarLoadFailed = ref(false);
const navigationItems = computed(() => [
  [
    {
      label: t("nav.assemblies"),
      to: localePath("/asambleas"),
      icon: "i-tabler-gavel",
    },
    ...(isAdmin.value
      ? [
          {
            label: t("nav.admin"),
            to: localePath("/admin"),
            icon: "i-tabler-settings",
          },
        ]
      : []),
  ],
]);

watch(
  () => session.value.data?.user?.image,
  () => {
    avatarLoadFailed.value = false;
  },
);

const userInitials = computed(() => {
  const name =
    session.value.data?.user?.name?.trim() ||
    session.value.data?.user?.email?.trim() ||
    "U";
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
});

useHead({
  titleTemplate: (titleChunk) =>
    titleChunk ? `${titleChunk} | ${t("app.title")}` : t("app.title"),
});
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <a
      href="#main-navigation"
      class="bg-primary text-primary-foreground sr-only z-50 rounded px-4 py-2 focus:not-sr-only focus:absolute focus:top-4 focus:left-4"
    >
      {{ t("accessibility.skipToNavigation") }}
    </a>
    <a
      href="#main-content"
      class="bg-primary text-primary-foreground sr-only z-50 rounded px-4 py-2 focus:not-sr-only focus:absolute focus:top-4 focus:left-48"
    >
      {{ t("accessibility.skipToMain") }}
    </a>

    <UHeader>
      <template #left>
        <NuxtLink
          :to="localePath('/')"
          class="inline-flex h-10 shrink-0 items-center text-primary"
          :aria-label="t('app.title')"
        >
          <UIcon name="i-tabler-list-numbers" class="block size-7" />
        </NuxtLink>

        <nav
          id="main-navigation"
          tabindex="-1"
          class="ml-6 hidden lg:block"
          :aria-label="t('accessibility.skipToNavigation')"
        >
          <UNavigationMenu :items="navigationItems" />
        </nav>
      </template>

      <template #right>
        <UColorModeButton />

        <UDropdownMenu :items="localeMenuItems">
          <UButton
            :icon="currentLocale?.icon"
            color="neutral"
            variant="ghost"
            size="lg"
            :aria-label="t('language.openMenu')"
            :title="t('language.toggle')"
          />
        </UDropdownMenu>

        <ClientOnly>
          <UDropdownMenu
            :items="[
              [
                {
                  label: t('auth.signOut'),
                  icon: 'i-tabler-logout',
                  onSelect: signOut,
                },
              ],
            ]"
          >
            <UButton
              variant="ghost"
              class="rounded-full p-0"
              :aria-label="t('accessibility.userMenu')"
              :title="t('accessibility.userMenu')"
            >
              <img
                v-if="session.data?.user?.image && !avatarLoadFailed"
                :src="session.data.user.image"
                :alt="
                  t('accessibility.userAvatar', {
                    user: session.data?.user?.name || session.data?.user?.email,
                  })
                "
                class="size-8 rounded-full"
                loading="eager"
                @error="avatarLoadFailed = true"
              />
              <div
                v-else
                class="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-full text-xs font-semibold"
              >
                {{ userInitials }}
              </div>
            </UButton>
          </UDropdownMenu>

          <template #fallback>
            <div class="bg-muted size-8 rounded-full" aria-hidden="true" />
          </template>
        </ClientOnly>
      </template>
    </UHeader>

    <UMain id="main-content" class="flex-1">
      <slot />
    </UMain>
  </div>
</template>
