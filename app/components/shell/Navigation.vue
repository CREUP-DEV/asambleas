<script lang="ts">
import { CALENDAR_RULES_PERMISSION } from "~~/shared/constants/calendarRules";
import type { NavigationMenuItem } from "@nuxt/ui";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AssemblyDto } from "~~/shared/types/api";

/**
 * Routes of the assembly sections, kept with the list of sections in
 * `-sections.ts` and exported here for the components that link to them.
 */
export {
  ASSEMBLY_SECTION_SEGMENTS,
  assemblyPath,
  projectionPath,
  type AssemblySection,
} from "~/composables/assembly/-sections";
</script>

<script setup lang="ts">
/**
 * Sidebar navigation: main sections, the contextual block of the assembly
 * being viewed (useAssemblySections) and the administration group, each
 * gated by permissions.
 *
 * "En directo" (the attendees' live view) is listed for everyone at any
 * time, right after the overview: the page itself says when the session
 * has not started or is over, so shared links keep working and the menu
 * does not shift when the session starts. While it is in session the item
 * carries a "now" mark.
 */
const props = defineProps<{ collapsed?: boolean }>();

const { t } = useI18n();
const localePath = useLocalePath();
const route = useRoute();
const { can, isAdmin } = useMe();

const currentAssembly = useState<AssemblyDto | null>(
  "current-assembly",
  () => null,
);

function normalize(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

const currentPath = computed(() => normalize(route.path));

function isWithin(path: string): boolean {
  const target = normalize(path);
  return (
    currentPath.value === target || currentPath.value.startsWith(`${target}/`)
  );
}

/** The stored assembly, only while the route is inside that assembly. */
const assembly = computed<AssemblyDto | null>(() => {
  const stored = currentAssembly.value;
  const param = route.params.assembly;
  const routeAssembly = typeof param === "string" ? param : null;
  if (!stored || !routeAssembly) return null;
  return routeAssembly === stored.slug || routeAssembly === stored.id
    ? stored
    : null;
});

const mainItems = computed<NavigationMenuItem[]>(() => {
  const home = localePath("/");
  const assemblies = localePath("/asambleas");
  return [
    {
      label: t("shell.nav.home"),
      icon: "i-lucide-house",
      to: home,
      active: currentPath.value === normalize(home),
    },
    {
      label: t("shell.nav.assemblies"),
      icon: "i-lucide-landmark",
      to: assemblies,
      active: isWithin(assemblies),
    },
  ];
});

/**
 * The assembly's sections, from the list the phone toolbar of the hub uses
 * too. Whoever has a section of the Secretaría or the Mesa sees them under
 * three small titles; everyone else gets one list.
 */
const { groups: sectionGroups } = useAssemblySections(assembly);

const assemblyItems = computed<NavigationMenuItem[]>(() => {
  const current = assembly.value;
  if (!current) return [];
  const items: NavigationMenuItem[] = [
    { type: "label", label: current.label, class: "text-highlighted" },
  ];
  for (const group of sectionGroups.value) {
    if (group.label) items.push({ type: "label", label: group.label });
    items.push(...group.items);
  }
  return items;
});

/**
 * Each admin page by the permission that opens it (an Admin sees all), plus
 * the activity log, which only an Admin opens.
 */
const adminItems = computed<NavigationMenuItem[]>(() => {
  const items: NavigationMenuItem[] = [];
  if (can(PERMISSION_KEYS.USER_MANAGE_ROLES)) {
    const users = localePath("/admin/usuarios");
    items.push({
      label: t("shell.nav.users"),
      icon: "i-lucide-users",
      to: users,
      active: isWithin(users),
    });
  }
  if (can(PERMISSION_KEYS.ROLE_MANAGE_PERMISSIONS)) {
    const roles = localePath("/admin/roles");
    items.push({
      label: t("shell.nav.roles"),
      icon: "i-lucide-shield-check",
      to: roles,
      active: isWithin(roles),
    });
  }
  if (can(PERMISSION_KEYS.MEMBER_MANAGE)) {
    const members = localePath("/admin/miembros");
    items.push({
      label: t("shell.nav.members"),
      icon: "i-lucide-building-2",
      to: members,
      active: isWithin(members),
    });
  }
  if (can(CALENDAR_RULES_PERMISSION)) {
    const calendarRules = localePath("/admin/calendario");
    items.push({
      label: t("shell.nav.calendarRules"),
      icon: "i-lucide-calendar-cog",
      to: calendarRules,
      active: isWithin(calendarRules),
    });
  }
  // The whole activity log: Admins only, by their real role. Secretaría
  // and Presidencia hold every permission key, so no key opens it; while
  // an Admin acts as another account, `isAdmin` is that account's.
  if (isAdmin.value) {
    const activity = localePath("/admin/actividad");
    items.push({
      label: t("shell.nav.activity"),
      icon: "i-lucide-scroll-text",
      to: activity,
      active: isWithin(activity),
    });
  }
  return items.length > 0
    ? [{ type: "label", label: t("shell.nav.admin") }, ...items]
    : [];
});

const menuUi = {
  link: "min-h-9",
  linkLeadingIcon: "size-5",
  label: "pt-3 text-xs uppercase tracking-wide text-dimmed truncate",
};
</script>

<template>
  <div class="flex flex-col gap-2">
    <UNavigationMenu
      :items="mainItems"
      orientation="vertical"
      :collapsed="props.collapsed"
      tooltip
      :ui="menuUi"
      :aria-label="t('shell.nav.mainLabel')"
    />

    <!--
      On the server the hub's route middleware stores the assembly before the
      layout renders, so this block is in the first HTML.
    -->
    <template v-if="assemblyItems.length > 0">
      <USeparator v-if="props.collapsed" class="px-2" />
      <UNavigationMenu
        :items="assemblyItems"
        orientation="vertical"
        :collapsed="props.collapsed"
        tooltip
        :ui="menuUi"
        :aria-label="
          t('shell.assembly.navLabel', { assembly: assembly?.label ?? '' })
        "
      />
    </template>

    <template v-if="adminItems.length > 0">
      <USeparator v-if="props.collapsed" class="px-2" />
      <UNavigationMenu
        :items="adminItems"
        orientation="vertical"
        :collapsed="props.collapsed"
        tooltip
        :ui="menuUi"
        :aria-label="t('shell.nav.admin')"
      />
    </template>
  </div>
</template>
