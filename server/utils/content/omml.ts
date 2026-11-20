import { z } from "zod/v4";

/**
 * Word equations (Office Math, OMML) as LaTeX, for the DOCX import (user's
 * decision of 2026-11-20). The converter process hands each equation over
 * as a small tree (docx.ts, MATH_SCRIPT): `n` its OMML element name without
 * namespace, `v` its `m:val`, `c` its children (strings are text). It is
 * untrusted: checked here (ommlTreeSchema, bounded depth and size), then
 * written as LaTeX that Temml and MathJax both read.
 *
 * Words with spaces (a variable written out, "Gasto público consolidado")
 * keep their spaces in \textit{}, upright ones (m:sty "p", m:nor) in
 * \text{}; signs Word types as text ("·", "×") become their commands; an
 * apostrophe is a prime, as in Word and LaTeX; a decimal comma between
 * digits ("0,4") is written "0{,}4", without the space after a comma.
 * An element this does not know is read through its children.
 */

export interface OmmlNode {
  n: string;
  v?: string;
  c?: (OmmlNode | string)[];
}

const MAX_DEPTH = 40;
const MAX_NODES = 4_000;

const nodeSchema: z.ZodType<OmmlNode> = z.lazy(() =>
  z.object({
    n: z.string().max(40),
    v: z.string().max(40).optional(),
    c: z
      .array(z.union([z.string().max(4_000), nodeSchema]))
      .max(500)
      .optional(),
  }),
);

/** A tree as the converter sends it, or null when it is not one. */
export function parseOmmlTree(json: string): OmmlNode | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = nodeSchema.safeParse(value);
  if (!parsed.success) return null;
  let count = 0;
  const within = (node: OmmlNode | string, depth: number): boolean => {
    if (typeof node === "string") return true;
    count += 1;
    if (depth > MAX_DEPTH || count > MAX_NODES) return false;
    return (node.c ?? []).every((child) => within(child, depth + 1));
  };
  return within(parsed.data, 0) ? parsed.data : null;
}

const MATH_ESCAPES: Record<string, string> = {
  "\\": "\\backslash ",
  "{": "\\{",
  "}": "\\}",
  "%": "\\%",
  "#": "\\#",
  "&": "\\&",
  _: "\\_",
  $: "\\$",
  "^": "\\hat{}",
  "~": "\\sim ",
  "·": "\\cdot ",
  "⋅": "\\cdot ",
  "×": "\\times ",
  "÷": "\\div ",
  "±": "\\pm ",
  "≤": "\\leq ",
  "≥": "\\geq ",
  "≠": "\\neq ",
  "≈": "\\approx ",
  "∞": "\\infty ",
};

const TEXT_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  "%": "\\%",
  "#": "\\#",
  "&": "\\&",
  _: "\\_",
  $: "\\$",
  "^": "ˆ",
  "~": "∼",
};

function escapeWith(text: string, table: Record<string, string>): string {
  return [...text].map((char) => table[char] ?? char).join("");
}

const NARY: Record<string, string> = {
  "∑": "\\sum",
  "∏": "\\prod",
  "∐": "\\coprod",
  "∫": "\\int",
  "∬": "\\iint",
  "∭": "\\iiint",
  "∮": "\\oint",
  "⋃": "\\bigcup",
  "⋂": "\\bigcap",
  "⋁": "\\bigvee",
  "⋀": "\\bigwedge",
};

const ACCENTS: Record<string, string> = {
  "̂": "\\hat",
  "̃": "\\tilde",
  "̄": "\\bar",
  "̅": "\\overline",
  "⃗": "\\vec",
  "̇": "\\dot",
  "̈": "\\ddot",
  "́": "\\acute",
  "̀": "\\grave",
  "̆": "\\breve",
  "̌": "\\check",
};

const FUNCTIONS = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "log",
  "ln",
  "exp",
  "lim",
  "max",
  "min",
  "sup",
  "inf",
  "det",
  "gcd",
]);

/** LaTeX delimiters for an OMML delimiter character ("" = none). */
function delimiter(char: string | undefined, fallback: string): string {
  const value = char ?? fallback;
  if (value === "") return ".";
  if (value === "{") return "\\{";
  if (value === "}") return "\\}";
  if (value === "|") return "|";
  if (value === "‖") return "\\|";
  if (value === "⟨" || value === "〈") return "\\langle";
  if (value === "⟩" || value === "〉") return "\\rangle";
  if (value === "⌊") return "\\lfloor";
  if (value === "⌋") return "\\rfloor";
  if (value === "⌈") return "\\lceil";
  if (value === "⌉") return "\\rceil";
  return /^[()[\]/.]$/.test(value) ? value : ".";
}

function children(node: OmmlNode): (OmmlNode | string)[] {
  return node.c ?? [];
}

function child(node: OmmlNode, name: string): OmmlNode | undefined {
  return children(node).find(
    (item): item is OmmlNode => typeof item !== "string" && item.n === name,
  );
}

/** The `m:val` of a property inside `node`'s properties element. */
function property(
  node: OmmlNode,
  properties: string,
  name: string,
): string | undefined {
  const holder = child(node, properties);
  return holder ? child(holder, name)?.v : undefined;
}

function textOf(node: OmmlNode | string): string {
  if (typeof node === "string") return node;
  return children(node).map(textOf).join("");
}

/** A run: its text, upright or as words where Word shows them so. */
function run(node: OmmlNode): string {
  const text = children(node)
    .filter(
      (item): item is OmmlNode => typeof item !== "string" && item.n === "t",
    )
    .map(textOf)
    .join("");
  if (!text) return "";
  const style = property(node, "rPr", "sty");
  const plain = Boolean(child(child(node, "rPr") ?? { n: "" }, "nor"));
  if (plain || style === "p")
    return `\\text{${escapeWith(text, TEXT_ESCAPES)}}`;
  // Words keep their spaces, which math mode would drop.
  if (/\s/.test(text.trim()) && /\p{L}{2}/u.test(text)) {
    const lead = text.match(/^\s*/)?.[0] ? "\\ " : "";
    const trail = text.match(/\s*$/)?.[0] ? "\\ " : "";
    return `${lead}\\textit{${escapeWith(text.trim(), TEXT_ESCAPES)}}${trail}`;
  }
  return escapeWith(text, MATH_ESCAPES);
}

/** An argument element (e, num, sub...) as a LaTeX group's content. */
function argument(node: OmmlNode | undefined): string {
  return node ? children(node).map(convert).join("") : "";
}

function group(content: string): string {
  return `{${content}}`;
}

function convert(node: OmmlNode | string): string {
  if (typeof node === "string") return escapeWith(node, MATH_ESCAPES);
  switch (node.n) {
    case "oMathPara":
      return children(node)
        .filter(
          (item): item is OmmlNode =>
            typeof item !== "string" && item.n === "oMath",
        )
        .map(convert)
        .join(" \\\\ ");
    case "r":
      return run(node);
    case "f": {
      const num = argument(child(node, "num"));
      const den = argument(child(node, "den"));
      const type = property(node, "fPr", "type");
      if (type === "lin") return `${group(num)}/${group(den)}`;
      if (type === "noBar")
        return `\\genfrac{}{}{0pt}{}${group(num)}${group(den)}`;
      return `\\frac${group(num)}${group(den)}`;
    }
    case "sSub": {
      const sub = argument(child(node, "sub"));
      const base = group(argument(child(node, "e")));
      return sub ? `${base}_${group(sub)}` : base;
    }
    case "sSup": {
      const sup = argument(child(node, "sup"));
      const base = group(argument(child(node, "e")));
      return sup ? `${base}^${group(sup)}` : base;
    }
    case "sSubSup": {
      const sub = argument(child(node, "sub"));
      const sup = argument(child(node, "sup"));
      let out = group(argument(child(node, "e")));
      if (sub) out += `_${group(sub)}`;
      if (sup) out += `^${group(sup)}`;
      return out;
    }
    case "sPre": {
      const sub = argument(child(node, "sub"));
      const sup = argument(child(node, "sup"));
      return `{}_${group(sub)}^${group(sup)}${group(argument(child(node, "e")))}`;
    }
    case "d": {
      const open = delimiter(property(node, "dPr", "begChr"), "(");
      const close = delimiter(property(node, "dPr", "endChr"), ")");
      const separator = property(node, "dPr", "sepChr") ?? "|";
      const parts = children(node)
        .filter(
          (item): item is OmmlNode =>
            typeof item !== "string" && item.n === "e",
        )
        .map((item) => argument(item));
      const sep =
        separator === "|" ? " \\mid " : escapeWith(separator, MATH_ESCAPES);
      return `\\left${open}${parts.join(sep)}\\right${close}`;
    }
    case "rad": {
      const degree = argument(child(node, "deg"));
      const hidden = property(node, "radPr", "degHide");
      const body = group(argument(child(node, "e")));
      return degree && hidden !== "1" && hidden !== "on"
        ? `\\sqrt[${degree}]${body}`
        : `\\sqrt${body}`;
    }
    case "nary": {
      const char = property(node, "naryPr", "chr") ?? "∫";
      const operator = NARY[char] ?? escapeWith(char, MATH_ESCAPES);
      const sub = argument(child(node, "sub"));
      const sup = argument(child(node, "sup"));
      let out = operator;
      if (sub) out += `_${group(sub)}`;
      if (sup) out += `^${group(sup)}`;
      return `${out}${group(argument(child(node, "e")))}`;
    }
    case "acc": {
      const char = property(node, "accPr", "chr") ?? "̂";
      const command = ACCENTS[char] ?? "\\hat";
      return `${command}${group(argument(child(node, "e")))}`;
    }
    case "bar": {
      const position = property(node, "barPr", "pos");
      const command = position === "top" ? "\\overline" : "\\underline";
      return `${command}${group(argument(child(node, "e")))}`;
    }
    case "groupChr": {
      const position = property(node, "groupChrPr", "pos");
      const command = position === "top" ? "\\overbrace" : "\\underbrace";
      return `${command}${group(argument(child(node, "e")))}`;
    }
    case "func": {
      const name = textOf(child(node, "fName") ?? { n: "" }).trim();
      const body = group(argument(child(node, "e")));
      if (FUNCTIONS.has(name)) return `\\${name}${body}`;
      return `${group(argument(child(node, "fName")))}${body}`;
    }
    case "limLow": {
      const lim = argument(child(node, "lim"));
      return `\\underset${group(lim)}${group(argument(child(node, "e")))}`;
    }
    case "limUpp": {
      const lim = argument(child(node, "lim"));
      return `\\overset${group(lim)}${group(argument(child(node, "e")))}`;
    }
    case "m": {
      const rows = children(node)
        .filter(
          (item): item is OmmlNode =>
            typeof item !== "string" && item.n === "mr",
        )
        .map((row) =>
          children(row)
            .filter(
              (item): item is OmmlNode =>
                typeof item !== "string" && item.n === "e",
            )
            .map((item) => argument(item))
            .join(" & "),
        );
      return `\\begin{matrix}${rows.join(" \\\\ ")}\\end{matrix}`;
    }
    case "eqArr": {
      const rows = children(node)
        .filter(
          (item): item is OmmlNode =>
            typeof item !== "string" && item.n === "e",
        )
        .map((item) => argument(item));
      return `\\begin{gathered}${rows.join(" \\\\ ")}\\end{gathered}`;
    }
    case "borderBox":
      return `\\boxed${group(argument(child(node, "e")))}`;
    case "phant":
      return `\\phantom${group(argument(child(node, "e")))}`;
    case "t":
      return escapeWith(textOf(node), MATH_ESCAPES);
    default:
      // Properties say how, never what: left out.
      if (node.n.endsWith("Pr")) return "";
      return children(node).map(convert).join("");
  }
}

/** A Word equation as LaTeX, its spaces tidied. */
export function ommlToLatex(tree: OmmlNode): string {
  return convert(tree)
    .replace(/[ \t\n]+/g, " ")
    .replace(/\s+([_^])/g, "$1")
    .replace(/(\d),(?=\d)/g, "$1{,}")
    .trim();
}
