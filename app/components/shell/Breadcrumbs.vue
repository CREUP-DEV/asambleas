<script setup lang="ts">
import type { BreadcrumbItem } from "@nuxt/ui";

/**
 * The breadcrumb row, under the page's navbar: where the page is and the
 * way back up. Pages place it in the header of their panel, after the
 * navbar; the assembly hub does it for every page of an assembly.
 *
 * Large screens show the whole trail; the last crumb is the page on show
 * and is not a link. Below `lg` it is a single link to the level above.
 *
 * The row's height is `--shell-breadcrumb-height`, set on <main> by the
 * default layout, so pages that size themselves to the viewport can take
 * it off.
 *
 * `placement`:
 * - `row` (default): the row described above, at every width;
 * - `inline`: the whole trail alone, no row, for a navbar's centre on large
 *   screens (the assembly hub);
 * - `compact`: the row below `lg` only, for a page that shows `inline` on
 *   large screens; a panel using both sets `--shell-breadcrumb-height` to 0
 *   from `lg`.
 */
const props = withDefaults(
  defineProps<{ placement?: "row" | "inline" | "compact" }>(),
  { placement: "row" },
);

const { t } = useI18n();
const { crumbs, parent } = useBreadcrumbs();

const items = computed<BreadcrumbItem[]>(() =>
  crumbs.value.map((crumb) =>
    crumb.current
      ? { label: crumb.label, active: true }
      : { label: crumb.label, to: crumb.to, active: false },
  ),
);
</script>

<template>
  <UBreadcrumb
    v-if="props.placement === 'inline' && crumbs.length > 0"
    :items="items"
    color="neutral"
    class="min-w-0 print:hidden"
    :aria-label="t('shell.breadcrumb.label')"
  />
  <div
    v-else-if="props.placement !== 'inline' && crumbs.length > 0"
    class="border-default h-(--shell-breadcrumb-height) shrink-0 items-center border-b px-4 sm:px-6 print:hidden"
    :class="[
      parent ? 'flex' : 'hidden',
      props.placement === 'compact' ? 'lg:hidden' : 'lg:flex',
    ]"
  >
    <UBreadcrumb
      :items="items"
      color="neutral"
      class="hidden lg:block"
      :aria-label="t('shell.breadcrumb.label')"
    />

    <nav
      v-if="parent"
      class="flex min-w-0 lg:hidden"
      :aria-label="t('shell.breadcrumb.label')"
    >
      <ULink
        :to="parent.to"
        class="text-muted hover:text-default -ms-1 flex min-w-0 items-center gap-1 text-sm font-medium transition-colors"
        :aria-label="t('shell.breadcrumb.backTo', { label: parent.label })"
      >
        <UIcon
          name="i-lucide-chevron-left"
          class="size-5 shrink-0"
          aria-hidden="true"
        />
        <span class="truncate">{{ parent.label }}</span>
      </ULink>
    </nav>
  </div>
</template>
