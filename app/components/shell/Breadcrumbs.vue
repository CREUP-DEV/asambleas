<script setup lang="ts">
/**
 * The breadcrumb row, under the page's navbar: where the page is and the
 * way back up. Pages place it in the header of their panel, after the
 * navbar; the assembly hub does it for every page of an assembly.
 *
 * Large screens show the whole trail (ShellBreadcrumbTrail: its start and
 * its end always show, the middle gives way); the last crumb is the page
 * on show and is not a link. Below `lg` it is a single link to the level
 * above, as tall as a thumb needs (the row's 40px, 44px in a navbar) while
 * it looks as small as before. A level whose name its page has not
 * registered yet (`pending`) shows as a skeleton, its provisional label
 * only for screen readers (the link's own name).
 * A page with no level above it gets no row (user's decision of
 * 2026-11-20): its navbar already names it.
 *
 * The row's height is `--shell-breadcrumb-height`, set on <main> by the
 * default layout, so pages that size themselves to the viewport can take
 * it off.
 *
 * `placement`:
 * - `row` (default): the row described above, at every width;
 * - `inline`: the whole trail alone, no row, for a navbar (the assembly
 *   hub, from `md`);
 * - `back`: the link to the level above alone, no row, for a navbar where
 *   the whole trail does not fit (the assembly hub on phones). A panel
 *   that puts the trail in its navbar sets `--shell-breadcrumb-height` to 0.
 */
const props = withDefaults(
  defineProps<{ placement?: "row" | "inline" | "back" }>(),
  { placement: "row" },
);

const { t } = useI18n();
const { crumbs, parent } = useBreadcrumbs();
const parentPending = computed(() => parent.value?.pending === true);
</script>

<template>
  <ShellBreadcrumbTrail
    v-if="props.placement === 'inline' && crumbs.length > 0"
    :crumbs="crumbs"
    class="min-w-0 flex-1 print:hidden"
    :label="t('shell.breadcrumb.label')"
  />
  <nav
    v-else-if="props.placement === 'back' && parent"
    class="flex min-w-0 print:hidden"
    :aria-label="t('shell.breadcrumb.label')"
  >
    <ULink
      :to="parent.to"
      class="text-muted hover:text-default -my-2 flex min-h-11 min-w-0 items-center gap-1 text-sm font-medium transition-colors"
      :aria-label="t('shell.breadcrumb.backTo', { label: parent.label })"
    >
      <UIcon
        name="i-lucide-chevron-left"
        class="size-5 shrink-0"
        aria-hidden="true"
      />
      <USkeleton v-if="parentPending" aria-hidden="true" class="h-4 w-20" />
      <span v-else class="truncate">{{ parent.label }}</span>
    </ULink>
  </nav>
  <!-- Only with a level above it: a top-level page (Asambleas, Mi
       actividad) would repeat in a row of its own what its navbar already
       says, as the administration pages, which have no trail, never do. -->
  <div
    v-else-if="props.placement === 'row' && parent"
    class="border-default flex h-(--shell-breadcrumb-height) shrink-0 items-center border-b px-4 sm:px-6 print:hidden"
  >
    <ShellBreadcrumbTrail
      :crumbs="crumbs"
      class="hidden min-w-0 flex-1 lg:flex"
      :label="t('shell.breadcrumb.label')"
    />

    <nav
      v-if="parent"
      class="flex min-w-0 self-stretch lg:hidden"
      :aria-label="t('shell.breadcrumb.label')"
    >
      <ULink
        :to="parent.to"
        class="text-muted hover:text-default -ms-1 flex min-w-0 items-center gap-1 self-stretch text-sm font-medium transition-colors"
        :aria-label="t('shell.breadcrumb.backTo', { label: parent.label })"
      >
        <UIcon
          name="i-lucide-chevron-left"
          class="size-5 shrink-0"
          aria-hidden="true"
        />
        <USkeleton v-if="parentPending" aria-hidden="true" class="h-4 w-20" />
        <span v-else class="truncate">{{ parent.label }}</span>
      </ULink>
    </nav>
  </div>
</template>
