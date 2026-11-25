import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import buttonTheme from "~~/.nuxt/ui/button";
import checkboxTheme from "~~/.nuxt/ui/checkbox";
import checkboxGroupTheme from "~~/.nuxt/ui/checkbox-group";
import dropdownMenuTheme from "~~/.nuxt/ui/dropdown-menu";
import fileUploadTheme from "~~/.nuxt/ui/file-upload";
import inputTheme from "~~/.nuxt/ui/input";
import inputDateTheme from "~~/.nuxt/ui/input-date";
import inputNumberTheme from "~~/.nuxt/ui/input-number";
import linkTheme from "~~/.nuxt/ui/link";
import navigationMenuTheme from "~~/.nuxt/ui/navigation-menu";
import pageCardTheme from "~~/.nuxt/ui/page-card";
import radioGroupTheme from "~~/.nuxt/ui/radio-group";
import selectTheme from "~~/.nuxt/ui/select";
import selectMenuTheme from "~~/.nuxt/ui/select-menu";
import switchTheme from "~~/.nuxt/ui/switch";
import tableTheme from "~~/.nuxt/ui/table";
import tabsTheme from "~~/.nuxt/ui/tabs";
import textareaTheme from "~~/.nuxt/ui/textarea";
import toastTheme from "~~/.nuxt/ui/toast";

// The theme merges the way Nuxt UI merges it (`tv({ extend: theme,
// ...appConfig.ui.x })`), with the tailwind-variants Nuxt UI ships.
const requireFromUi = createRequire(
  fileURLToPath(
    new URL("../node_modules/@nuxt/ui/package.json", import.meta.url),
  ),
);
const { tv } = requireFromUi("tailwind-variants") as {
  tv: (config: object) => (props: object) => unknown;
};

type Config = Record<string, unknown>;
let ui: Record<string, Config>;

beforeAll(async () => {
  (globalThis as Record<string, unknown>).defineAppConfig = (c: unknown) => c;
  ui = (
    (await import("./app.config")).default as { ui: Record<string, Config> }
  ).ui;
});

/** Every slot's classes for one set of props, as a component gets them. */
function classes(
  name: string,
  theme: object,
  props: Record<string, unknown>,
): Record<string, string> {
  const result = tv({ extend: theme, ...ui[name] })(props);
  if (typeof result === "string") return { base: result };
  return Object.fromEntries(
    Object.entries(result as Record<string, (p?: object) => string>).map(
      ([slot, fn]) => [slot, fn() ?? ""],
    ),
  );
}

const COLORS = [
  "primary",
  "secondary",
  "sectorial",
  "success",
  "info",
  "warning",
  "error",
  "neutral",
] as const;
const SOLID = (color: string) =>
  color === "neutral" ? "outline-inverted" : `outline-${color}`;
const FADED = /(^|[\s:])outline-[a-z]+\/25(\s|$)/;

/** Every combination of the given variants, colour first. */
function combos(theme: { variants?: Record<string, object> }, keys: string[]) {
  let list: Record<string, unknown>[] = [{}];
  for (const key of ["color", ...keys]) {
    const values = Object.keys(theme.variants?.[key] ?? {});
    if (values.length === 0) continue;
    list = list.flatMap((props) =>
      values.map((value) => ({
        ...props,
        [key]: value === "true" ? true : value === "false" ? false : value,
      })),
    );
  }
  return list;
}

describe("app.config focus ring", () => {
  it.each([
    ["button", buttonTheme, ["variant"]],
    ["link", linkTheme, []],
    ["navigationMenu", navigationMenuTheme, ["variant"]],
    ["input", inputTheme, ["variant"]],
    ["textarea", textareaTheme, ["variant"]],
    ["inputNumber", inputNumberTheme, ["variant"]],
    ["inputDate", inputDateTheme, ["variant"]],
    ["select", selectTheme, ["variant"]],
    ["selectMenu", selectMenuTheme, ["variant"]],
    ["checkbox", checkboxTheme, ["variant", "indicator"]],
    ["checkboxGroup", checkboxGroupTheme, ["variant"]],
    ["radioGroup", radioGroupTheme, ["variant", "indicator"]],
    ["switch", switchTheme, []],
    ["tabs", tabsTheme, ["variant"]],
    ["fileUpload", fileUploadTheme, []],
    ["table", tableTheme, []],
    ["pageCard", pageCardTheme, ["to"]],
    ["toast", toastTheme, []],
  ] as const)("leaves no 25 percent ring in %s", (name, theme, keys) => {
    for (const props of combos(theme as never, [...keys])) {
      for (const [slot, value] of Object.entries(classes(name, theme, props))) {
        expect(value, `${name} ${JSON.stringify(props)} ${slot}`).not.toMatch(
          FADED,
        );
      }
    }
  });

  it.each(COLORS)("draws a solid %s ring off a button's edge", (color) => {
    for (const variant of [
      "solid",
      "outline",
      "soft",
      "subtle",
      "ghost",
      "link",
    ]) {
      const base = classes("button", buttonTheme, { color, variant }).base!;
      const tokens = base.split(" ");
      expect(tokens).toContain(SOLID(color));
      expect(tokens).toContain("focus-visible:outline-2");
      expect(tokens).toContain("focus-visible:outline-offset-2");
      expect(tokens).not.toContain("focus-visible:outline-3");
    }
  });

  it("keeps a text field's colour ring and a 2px solid outline", () => {
    const base = classes("input", inputTheme, {
      color: "primary",
      variant: "outline",
    }).base!.split(" ");
    expect(base).toEqual(
      expect.arrayContaining([
        "outline-primary",
        "focus-visible:outline-2",
        "focus-visible:ring-primary",
      ]),
    );
    expect(base).not.toContain("focus-visible:outline-3");
  });

  it("leaves a borderless field without an outline", () => {
    const base = classes("input", inputTheme, {
      color: "primary",
      variant: "none",
    }).base!.split(" ");
    expect(base).toContain("focus:outline-none");
    expect(base).not.toContain("focus-visible:outline-2");
  });

  it("rings a focused radio card in its colour, checked or not", () => {
    const item = classes("radioGroup", radioGroupTheme, {
      color: "primary",
      variant: "card",
    }).item!.split(" ");
    expect(item).toEqual(
      expect.arrayContaining([
        "outline-primary",
        "has-focus-visible:outline-3",
      ]),
    );
  });

  it.each(COLORS)("rings a focused %s toast solid", (color) => {
    const root = classes("toast", toastTheme, { color }).root!.split(" ");
    expect(root).toEqual(
      expect.arrayContaining([
        SOLID(color),
        "focus-visible:outline-3",
        `focus-visible:ring-${color === "neutral" ? "inverted" : color}`,
      ]),
    );
  });

  it("draws the navigation menu's ring solid on the link", () => {
    const slots = classes("navigationMenu", navigationMenuTheme, {
      color: "primary",
    });
    expect(slots.link!.split(" ")).toContain("before:outline-primary");
    expect(slots.childLink!.split(" ")).toContain("before:outline-primary");
  });
});

describe("app.config text size of small fields", () => {
  it.each([
    ["input", inputTheme],
    ["textarea", textareaTheme],
    ["inputNumber", inputNumberTheme],
    ["inputDate", inputDateTheme],
  ] as const)("writes %s at 16px below md and 12px from md", (name, theme) => {
    for (const size of ["xs", "sm"]) {
      const base = classes(name, theme, { size }).base!.split(" ");
      expect(base).toContain("text-base/4");
      expect(base).toContain("md:text-xs");
      expect(base).not.toContain("text-sm/4");
    }
  });

  it("leaves md fields as the theme has them", () => {
    const base = classes("input", inputTheme, { size: "md" }).base!.split(" ");
    expect(base).toEqual(expect.arrayContaining(["text-base/5", "md:text-sm"]));
  });
});

describe("app.config dropdown menu", () => {
  it("fits the screen, wraps descriptions and gives items room on phones", () => {
    const slots = classes("dropdownMenu", dropdownMenuTheme, {});
    expect(slots.content!.split(" ")).toContain("max-w-[calc(100vw-2rem)]");
    expect(slots.item!.split(" ")).toContain("max-sm:py-2.5");
    for (const slot of ["itemLabel", "itemDescription"]) {
      const tokens = slots[slot]!.split(" ");
      expect(tokens).toEqual(
        expect.arrayContaining([
          "text-clip",
          "whitespace-normal",
          "break-words",
        ]),
      );
      expect(tokens).not.toContain("truncate");
    }
  });
});
