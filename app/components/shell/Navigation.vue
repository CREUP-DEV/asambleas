<script lang="ts">
import type { NavigationMenuItem } from "@nuxt/ui";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AssemblyDto } from "~~/shared/types/api";

/**
 * Routes of the assembly sections. Pages under app/pages/asambleas/[assembly]/
 * and app/pages/proyeccion/[assembly].vue must live at these paths, since the
 * sidebar links to them.
 */
export const ASSEMBLY_SECTION_SEGMENTS = {
  overview: "",
  agenda: "orden-del-dia",
  documents: "documentos",
  calendar: "calendario",
  convocation: "convocatoria",
  session: "sesion",
  settings: "ajustes",
} as const;

export type AssemblySection = keyof typeof ASSEMBLY_SECTION_SEGMENTS;

/** Unlocalized path of an assembly section: `/asambleas/80-ago/sesion`. */
export function assemblyPath(
  slug: string,
  section: AssemblySection = "overview",
): string {
  const segment = ASSEMBLY_SECTION_SEGMENTS[section];
  const base = `/asambleas/${encodeURIComponent(slug)}`;
  return segment ? `${base}/${segment}` : base;
}

/** Unlocalized path of the chrome-free projection view. */
export function projectionPath(slug: string): string {
  return `/proyeccion/${encodeURIComponent(slug)}`;
}
</script>

<script setup lang="ts">
/**
 * Sidebar navigation: main sections, the contextual block of the assembly
 * being viewed and the administration group, each gated by permissions.
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

const assemblyItems = computed<NavigationMenuItem[]>(() => {
  const current = assembly.value;
  if (!current) return [];
  const path = (section: AssemblySection) =>
    localePath(assemblyPath(current.slug, section));
  const overview = path("overview");

  const items: NavigationMenuItem[] = [
    { type: "label", label: current.label },
    {
      label: t("shell.assembly.overview"),
      icon: "i-lucide-layout-dashboard",
      to: overview,
      exact: true,
      active: currentPath.value === normalize(overview),
    },
    {
      label: t("shell.assembly.agenda"),
      icon: "i-lucide-list-tree",
      to: path("agenda"),
      active: isWithin(path("agenda")) || isWithin(path("documents")),
    },
    {
      label: t("shell.assembly.calendar"),
      icon: "i-lucide-calendar-days",
      to: path("calendar"),
      active: isWithin(path("calendar")),
    },
    {
      label: t("shell.assembly.convocation"),
      icon: "i-lucide-scroll-text",
      to: path("convocation"),
      active: isWithin(path("convocation")),
    },
  ];

  if (current.can.moderate) {
    items.push({
      label: t("shell.assembly.session"),
      icon: "i-lucide-gavel",
      to: path("session"),
      active: isWithin(path("session")),
    });
  }

  items.push({
    label: t("shell.assembly.projection"),
    icon: "i-lucide-presentation",
    to: localePath(projectionPath(current.slug)),
    target: "_blank",
    active: false,
    trailingIcon: "i-lucide-external-link",
    "aria-label": t("shell.assembly.projectionNewTab"),
  });

  if (current.can.manage) {
    items.push({
      label: t("shell.assembly.settings"),
      icon: "i-lucide-settings",
      to: path("settings"),
      active: isWithin(path("settings")),
    });
  }

  return items;
});

const adminItems = computed<NavigationMenuItem[]>(() => {
  const items: NavigationMenuItem[] = [];
  if (isAdmin.value) {
    const users = localePath("/admin/usuarios");
    const roles = localePath("/admin/roles");
    items.push(
      {
        label: t("shell.nav.users"),
        icon: "i-lucide-users",
        to: users,
        active: isWithin(users),
      },
      {
        label: t("shell.nav.roles"),
        icon: "i-lucide-shield-check",
        to: roles,
        active: isWithin(roles),
      },
    );
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
