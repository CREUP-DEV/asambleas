<script setup lang="ts">
const { t } = useI18n();
const localePath = useLocalePath();

definePageMeta({
  layout: "admin",
});

useHead({
  title: t("nav.dashboard"),
});

const cards = computed(() => [
  {
    label: t("admin.users.title"),
    icon: "i-tabler-users",
    to: localePath("/admin/usuarios"),
    description: t("admin.users.title"),
  },
  {
    label: t("admin.roles.title"),
    icon: "i-tabler-shield",
    to: localePath("/admin/roles"),
    description: t("admin.roles.permissions"),
  },
]);
</script>

<template>
  <div>
    <h1 class="text-2xl font-bold">{{ t("admin.dashboard") }}</h1>

    <div class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <UCard v-for="card in cards" :key="card.to">
        <div class="flex items-center gap-3">
          <div
            class="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg"
          >
            <UIcon :name="card.icon" class="size-5" />
          </div>
          <div>
            <p class="font-semibold">{{ card.label }}</p>
            <p class="text-muted text-sm">{{ card.description }}</p>
          </div>
        </div>
        <template #footer>
          <UButton :to="card.to" variant="soft" block>
            {{ card.label }}
          </UButton>
        </template>
      </UCard>
    </div>
  </div>
</template>
