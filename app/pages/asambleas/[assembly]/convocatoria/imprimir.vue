<script setup lang="ts">
/**
 * The generated convocatoria alone, ready to print. It leaves the app shell
 * (`layout: false`) and the hub renders it without its chrome
 * (`meta.print`); the toolbar is hidden when printing. The page inside the
 * hub (convocatoria/index.vue) links here.
 */
definePageMeta({ print: true, layout: false });

const { t, locale } = useI18n();
const { assembly, sectionPath } = useCurrentAssembly();

await useAssemblyAgenda();

useHead({
  title: () =>
    assembly.value
      ? t("convocation.heading", {
          assembly: `${assemblyOrdinal(assembly.value.number, locale.value)} ${t(`assembly.types.${assembly.value.type}`)}`,
        })
      : t("shell.assembly.convocation"),
});

function printPage() {
  if (import.meta.client) window.print();
}
</script>

<template>
  <main
    v-if="assembly"
    id="main-content"
    class="bg-muted/40 min-h-svh print:min-h-0 print:bg-transparent"
  >
    <div
      class="no-print border-default bg-default/95 sticky top-0 z-10 border-b backdrop-blur"
    >
      <UContainer
        class="flex flex-wrap items-center justify-between gap-2 py-2"
      >
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-arrow-left"
          :label="t('convocation.back')"
          :to="sectionPath('convocatoria')"
        />
        <UButton
          icon="i-lucide-printer"
          :label="t('convocation.print')"
          @click="printPage"
        />
      </UContainer>
    </div>

    <div class="px-4 py-6 sm:py-10 print:p-0">
      <UAlert
        v-if="!assembly.agendaFinalizedAt || assembly.status === 'draft'"
        class="no-print mx-auto mb-4 max-w-3xl"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :title="
          assembly.status === 'draft'
            ? t('convocation.draftWarning')
            : t('convocation.provisionalWarning')
        "
      />
      <ConvocationSheet :heading-level="1" />
    </div>
  </main>
</template>
