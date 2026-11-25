/**
 * Status boxes (success, info, warning, error) keep their text neutral: the
 * colour goes on the icon, the tint and the ring only, since coloured text
 * on a tint of the same colour does not read (AGENTS.md, "Language, i18n And
 * Accessibility").
 */
const statusBox = (icon: string) => ({
  root: "text-default",
  title: "text-highlighted",
  icon,
});

/**
 * Short status labels (badges, buttons) keep their colour, one step darker
 * in light mode: the 700 token reads on white but not always on its own 10%
 * tint (yellow 4.3:1). Tailwind only generates classes it finds written out,
 * so every class is spelled in full.
 */
const ON_TINT = {
  success: "text-success-800 dark:text-success",
  info: "text-info-800 dark:text-info",
  warning: "text-warning-800 dark:text-warning",
  error: "text-error-800 dark:text-error",
} as const;

const BOX_ICON = {
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  error: "text-error",
} as const;

type StatusColor = keyof typeof ON_TINT;
const TINT_COLORS = Object.keys(ON_TINT) as StatusColor[];

/**
 * The keyboard focus ring is solid (E-001). Nuxt UI draws it in the
 * component's colour at 25%, 1.5:1 on the page, under the 3:1 a focus
 * indicator needs (WCAG 1.4.11, 2.4.7). Solid, every colour token reaches
 * 4.9:1 or more on `bg-default` and about 4.5:1 on `bg-muted` and
 * `bg-elevated` in both modes (the steps in main.css). Each entry below mirrors the condition and the
 * slot of the theme's own `/25` rule, which this one follows and overrides;
 * buttons and links also take the ring 2px off their edge, so it never melts
 * into a solid fill. Classes spelled in full, as above.
 */
const FOCUS = {
  primary: "outline-primary",
  secondary: "outline-secondary",
  sectorial: "outline-sectorial",
  success: "outline-success",
  info: "outline-info",
  warning: "outline-warning",
  error: "outline-error",
  neutral: "outline-inverted",
} as const;

/** The navigation menu draws its ring on the link's `::before`. */
const BEFORE_FOCUS = {
  primary: "before:outline-primary",
  secondary: "before:outline-secondary",
  sectorial: "before:outline-sectorial",
  success: "before:outline-success",
  info: "before:outline-info",
  warning: "before:outline-warning",
  error: "before:outline-error",
  neutral: "before:outline-inverted",
} as const;

type ThemeColor = keyof typeof FOCUS;
const THEME_COLORS = Object.keys(FOCUS) as ThemeColor[];

/** One compound per colour, under `when`, with the classes `slots` gives. */
const focusRing = <W extends object, C>(
  when: W,
  slots: (color: ThemeColor) => C,
) => THEME_COLORS.map((color) => ({ color, ...when, class: slots(color) }));

/** Text fields keep their 1px ring, which turns the same colour: 3px in all. */
const FIELD_VARIANTS = ["outline", "subtle", "soft", "ghost"];
const fieldFocus = focusRing(
  { variant: FIELD_VARIANTS },
  (color) => `${FOCUS[color]} focus-visible:outline-2`,
);

/**
 * Below md, xs and sm text fields write at 16px: iOS Safari zooms the page
 * into any field under 16px when it takes the focus (M-055, M-087, M-088).
 * The theme's `md:text-xs` (`fixed: false`) keeps them at 12px from md up,
 * as before, and the line stays 16px, so their height does not change.
 */
const PHONE_TEXT = { base: "text-base/4" };
const phoneSizes = { xs: PHONE_TEXT, sm: PHONE_TEXT };

export default defineAppConfig({
  ui: {
    // The dashboard is fixed to the viewport and starts below the
    // impersonation banner while it shows (layouts/default.vue): its sidebar
    // and panels fill the group, never a whole screen (min-h-svh), or they
    // overflow it by the banner's height and lose their header and footer.
    dashboardSidebar: { slots: { root: "min-h-full" } },
    // The panel's body scrolls, so it holds what is positioned inside it:
    // without `relative` an absolute element (every `sr-only` text) takes a
    // containing block outside it, escapes its scroll and stretches the
    // dashboard's own scroll to where it sits, a long empty stretch below a
    // tall page (the control sheet's count after its table).
    dashboardPanel: { slots: { root: "min-h-full", body: "relative" } },
    colors: {
      primary: "creup-red",
      secondary: "creup-blue",
      sectorial: "creup-green",
    },
    // The close button sits absolutely in the header's corner (end-4, 32px
    // wide), so the title and description keep clear of it, with a gap: a
    // long title would otherwise run under the X.
    modal: {
      slots: { wrapper: "min-w-0 pe-10" },
    },
    slideover: {
      slots: { wrapper: "min-w-0 pe-10" },
    },
    toast: {
      slots: {
        title: "text-sm font-medium text-highlighted select-text",
        description: "text-sm text-muted select-text",
      },
      // A toast takes the focus (Reka gives it `tabindex="0"`, F8 reaches it).
      compoundVariants: focusRing({}, (color) => ({ root: FOCUS[color] })),
    },
    alert: {
      compoundVariants: TINT_COLORS.map((color) => ({
        color,
        variant: ["subtle", "soft", "outline"],
        class: statusBox(BOX_ICON[color]),
      })),
    },
    badge: {
      compoundVariants: TINT_COLORS.map((color) => ({
        color,
        variant: ["subtle", "soft"],
        class: ON_TINT[color],
      })),
    },
    button: {
      compoundVariants: [
        ...TINT_COLORS.map((color) => ({
          color,
          variant: ["subtle", "soft", "outline", "ghost"],
          class: ON_TINT[color],
        })),
        ...focusRing(
          {},
          (color) =>
            `${FOCUS[color]} focus-visible:outline-2 focus-visible:outline-offset-2`,
        ),
      ],
    },
    link: {
      base: "outline-primary focus-visible:outline-2 focus-visible:outline-offset-2",
    },
    navigationMenu: {
      compoundVariants: focusRing({}, (color) => ({
        link: BEFORE_FOCUS[color],
        childLink: BEFORE_FOCUS[color],
      })),
    },
    input: {
      variants: { size: phoneSizes },
      compoundVariants: fieldFocus,
    },
    textarea: {
      variants: { size: phoneSizes },
      compoundVariants: fieldFocus,
    },
    inputNumber: {
      variants: { size: { xs: PHONE_TEXT.base, sm: PHONE_TEXT.base } },
      compoundVariants: fieldFocus,
    },
    // Its segments are editable text, which iOS zooms into like a field.
    inputDate: {
      variants: { size: phoneSizes },
      compoundVariants: focusRing(
        { variant: FIELD_VARIANTS },
        (color) => `${FOCUS[color]} has-focus-visible:outline-2`,
      ),
    },
    // Both open on a button, which iOS does not zoom into; the search box of
    // a select menu is a `UInput`, so the rule above covers it.
    select: { compoundVariants: fieldFocus },
    selectMenu: { compoundVariants: fieldFocus },
    // A checked box, a switch that is on and the active pill are filled with
    // the ring's colour: the ring stands off them.
    checkbox: {
      compoundVariants: [
        ...focusRing(
          { variant: "list", indicator: ["start", "end"] },
          (color) => ({
            base: `${FOCUS[color]} focus-visible:outline-offset-2`,
          }),
        ),
        ...focusRing({ variant: "card" }, (color) => ({ root: FOCUS[color] })),
        ...focusRing({ variant: "list", indicator: "hidden" }, (color) => ({
          root: FOCUS[color],
        })),
      ],
    },
    checkboxGroup: {
      compoundVariants: focusRing({ variant: "table" }, (color) => ({
        item: FOCUS[color],
      })),
    },
    // A focused card or row keeps its ring whether it is chosen or not (its
    // border alone, `primary/50` once checked, hardly changed).
    radioGroup: {
      compoundVariants: [
        ...focusRing(
          { variant: "list", indicator: ["start", "end"] },
          (color) => ({
            base: `${FOCUS[color]} focus-visible:outline-offset-2`,
          }),
        ),
        ...focusRing({ variant: ["card", "table"] }, (color) => ({
          item: FOCUS[color],
        })),
        ...focusRing({ variant: "list", indicator: "hidden" }, (color) => ({
          item: FOCUS[color],
        })),
      ],
    },
    switch: {
      compoundVariants: focusRing({}, (color) => ({
        base: `${FOCUS[color]} focus-visible:outline-offset-2`,
      })),
    },
    tabs: {
      compoundVariants: [
        ...focusRing({}, (color) => ({ content: FOCUS[color] })),
        ...focusRing({ variant: "pill" }, (color) => ({
          trigger: `${FOCUS[color]} focus-visible:outline-offset-2`,
        })),
        ...focusRing({ variant: "link" }, (color) => ({
          trigger: FOCUS[color],
        })),
      ],
    },
    fileUpload: { compoundVariants: focusRing({}, (color) => FOCUS[color]) },
    table: {
      slots: {
        root: "outline-primary",
        tbody: "[&>tr]:data-[selectable=true]:outline-primary",
      },
    },
    pageCard: {
      compoundVariants: [{ to: true, class: { root: "outline-primary" } }],
    },
    // Menus never run off a phone's screen, an item's description wraps
    // instead of losing its end (the name too, if it ever needs to), and
    // items are 40px tall under sm (M-022, M-039, M-069). `text-clip`, not
    // only `whitespace-normal`: it is what takes the theme's `truncate` out.
    dropdownMenu: {
      slots: {
        content: "max-w-[calc(100vw-2rem)]",
        item: "max-sm:py-2.5",
        itemLabel: "text-clip whitespace-normal break-words",
        itemDescription: "text-clip whitespace-normal break-words",
      },
    },
  },
});
