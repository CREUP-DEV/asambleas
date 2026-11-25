import type { NavigationMenuItem } from "@nuxt/ui";

/**
 * The sidebar's items as the folded sidebar needs them: there the theme
 * hides every link's label, so each link takes it as its accessible name
 * (E-003). A name the item already carries wins (useAssemblySections gives
 * «Proyección», «En directo» in session and «Validación» with its pending
 * count one that says more than the label), and the group titles
 * (`type: 'label'`) are left as they are. Unfolded, the items are returned
 * unchanged.
 */
export function namedWhenCollapsed(
  items: NavigationMenuItem[],
  collapsed: boolean | undefined,
): NavigationMenuItem[] {
  if (!collapsed) return items;
  return items.map((item) =>
    item.type === "label" || typeof item.label !== "string"
      ? item
      : { ...item, "aria-label": item["aria-label"] ?? item.label },
  );
}
