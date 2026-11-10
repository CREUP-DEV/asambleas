import type { NavigationMenuItem } from "@nuxt/ui";
import type { MaybeRefOrGetter } from "vue";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";
import type { AssemblyDto } from "~~/shared/types/api";
import {
  REVIEW_BADGE_STATE_KEY,
  type ReviewBadgeState,
} from "~/components/review/-queue";
import {
  assemblySectionPath,
  groupAssemblySections,
  visibleAssemblySections,
  type AssemblySectionDef,
  type AssemblySectionGroup,
} from "./-sections";

export interface AssemblySectionMenuGroup {
  /** Null for the single list of someone with no Secretaría or Mesa section. */
  group: AssemblySectionGroup | null;
  /** Title of the group, when it has one. */
  label: string | null;
  items: NavigationMenuItem[];
}

function normalize(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * The menu of an assembly's sections, for the sidebar (grouped) and the
 * phone toolbar of the hub (flat). Both show the same entries: which ones
 * depends only on what the viewer may do (see `-sections.ts`).
 *
 * The validation entry carries the Secretaría's pending count, which the
 * hub keeps in shared state once mounted.
 */
export function useAssemblySections(
  assembly: MaybeRefOrGetter<AssemblyDto | null | undefined>,
) {
  const { t } = useI18n();
  const localePath = useLocalePath();
  const route = useRoute();
  const { can } = useMe();

  const reviewBadge = useState<ReviewBadgeState | null>(
    REVIEW_BADGE_STATE_KEY,
    () => null,
  );

  const currentPath = computed(() => normalize(route.path));

  function toItem(
    current: AssemblyDto,
    section: AssemblySectionDef,
  ): NavigationMenuItem {
    const to = localePath(assemblySectionPath(current.slug, section.key));
    const label = t(`shell.assembly.${section.key}`);

    if (section.key === "projection") {
      return {
        label,
        icon: section.icon,
        to,
        target: "_blank",
        active: false,
        trailingIcon: "i-lucide-external-link",
        "aria-label": t("shell.assembly.projectionNewTab"),
      };
    }

    const target = normalize(to);
    // A document (documentos/<slug>/...) is a sibling route of the list, not
    // a child, so the router alone would not mark Documents active.
    const active =
      section.key === "overview"
        ? currentPath.value === target
        : currentPath.value === target ||
          currentPath.value.startsWith(`${target}/`);
    const item: NavigationMenuItem = {
      label,
      icon: section.icon,
      to,
      active,
      ...(section.key === "overview" ? { exact: true } : {}),
    };

    if (section.key === "live" && current.status === "in_session") {
      item.badge = {
        label: t("shell.assembly.liveNow"),
        color: "error",
        variant: "soft",
      };
      item["aria-label"] = t("shell.assembly.liveInSession");
    }

    if (section.key === "validation") {
      const pending =
        reviewBadge.value?.assemblyId === current.id
          ? reviewBadge.value.count
          : 0;
      if (pending > 0) {
        item.badge = {
          label: String(pending),
          color: "warning",
          variant: "solid",
        };
        item["aria-label"] = t(
          "shell.assembly.validationPending",
          { count: pending },
          pending,
        );
      }
    }

    return item;
  }

  /** The entries under their group titles (one untitled list for most). */
  const groups = computed<AssemblySectionMenuGroup[]>(() => {
    const current = toValue(assembly);
    if (!current) return [];
    const sections = visibleAssemblySections({
      validateDocuments: can(PERMISSION_KEYS.DOCUMENT_MANAGE),
      reviewAmendments: can(PERMISSION_KEYS.AMENDMENT_REVIEW),
      manage: current.can.manage,
      moderate: current.can.moderate,
    });
    return groupAssemblySections(sections).map(({ group, sections: list }) => ({
      group,
      label: group ? t(`shell.assemblyGroups.${group}`) : null,
      items: list.map((section) => toItem(current, section)),
    }));
  });

  /** The same entries in one list, in the same order. */
  const items = computed<NavigationMenuItem[]>(() =>
    groups.value.flatMap((group) => group.items),
  );

  return { groups, items };
}
