import temml from "temml";

/**
 * Formulas (user's decision of 2026-11-20): a formula block or a formula
 * mark keeps its LaTeX source as text, so amendments, diffs and merges treat
 * it as any text; it is drawn as MathML (Temml), which every current browser
 * lays out with no fonts of its own.
 *
 * This is the one place the renderer emits markup it did not build itself.
 * Temml runs untrusted (no \href, \url, \includegraphics or HTML macros)
 * with bounded expansion and sizes, and what it returns is checked, tag by
 * tag and attribute by attribute, against a MathML allowlist: anything else
 * (or a source that does not parse) shows as its escaped source instead.
 */

/** Longest source drawn as a formula; a longer one shows as its source. */
export const FORMULA_MAX_LENGTH = 4_000;

/** The colour Temml paints what it cannot read in (an unknown command). */
const TEMML_ERROR_COLOUR = "#b22222";

const TEMML_OPTIONS = {
  errorColor: TEMML_ERROR_COLOUR,
  trust: false,
  throwOnError: false,
  strict: false,
  annotate: true,
  maxSize: [20, 20] as [number, number],
  maxExpand: 300,
  wrap: "none" as const,
};

const ALLOWED_TAGS = new Set([
  "math",
  "semantics",
  "annotation",
  "mrow",
  "mi",
  "mn",
  "mo",
  "ms",
  "mtext",
  "mspace",
  "msub",
  "msup",
  "msubsup",
  "munder",
  "mover",
  "munderover",
  "mfrac",
  "msqrt",
  "mroot",
  "mstyle",
  "mpadded",
  "mphantom",
  "menclose",
  "mtable",
  "mtr",
  "mtd",
  "mlabeledtr",
  "mmultiscripts",
  "mprescripts",
  "none",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "display",
  "class",
  "style",
  "encoding",
  "mathvariant",
  "displaystyle",
  "scriptlevel",
  "width",
  "height",
  "depth",
  "lspace",
  "rspace",
  "voffset",
  "stretchy",
  "symmetric",
  "fence",
  "form",
  "separator",
  "movablelimits",
  "largeop",
  "accent",
  "accentunder",
  "linethickness",
  "minsize",
  "maxsize",
  "columnalign",
  "rowalign",
  "columnspacing",
  "rowspacing",
  "columnlines",
  "rowlines",
  "frame",
  "framespacing",
  "notation",
  "mathcolor",
  "mathbackground",
  "mathsize",
  "intent",
  "arg",
]);

/** Attribute values that could reach a URL or script, whatever the name. */
const UNSAFE_VALUE = /url\s*\(|expression|javascript:|@import|[\\<>`]/i;

const TAG =
  /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9:-]*="[^"]*")*)\s*(\/?)>/g;
const ATTRIBUTE = /([a-zA-Z][a-zA-Z0-9:-]*)="([^"]*)"/g;

/** Whether Temml's output is MathML of the allowed tags and attributes only. */
export function isSafeMathMl(markup: string): boolean {
  let rest = "";
  let last = 0;
  for (const match of markup.matchAll(TAG)) {
    rest += markup.slice(last, match.index);
    last = match.index + match[0].length;
    if (!ALLOWED_TAGS.has(match[2]!.toLowerCase())) return false;
    for (const attribute of match[3]!.matchAll(ATTRIBUTE)) {
      if (!ALLOWED_ATTRIBUTES.has(attribute[1]!.toLowerCase())) return false;
      if (UNSAFE_VALUE.test(attribute[2]!)) return false;
    }
  }
  rest += markup.slice(last);
  // Text between tags comes escaped: a bracket left is a tag not allowed.
  return !/[<>]/.test(rest);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A source that cannot be drawn, shown as it is written. */
function sourceHtml(source: string, display: boolean): string {
  const code = `<code class="cx-formula-source">${escapeHtml(source)}</code>`;
  return display
    ? `<div class="cx-formula cx-formula-error">${code}</div>`
    : code;
}

// Plain runs ---------------------------------------------------------------

/** A piece of a formula as plain text, raised or lowered. */
export interface FormulaRun {
  text: string;
  script?: "sub" | "sup";
}

const SYMBOLS: Record<string, string> = {
  cdot: "·",
  times: "×",
  div: "÷",
  pm: "±",
  mp: "∓",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  equiv: "≡",
  infty: "∞",
  sum: "∑",
  prod: "∏",
  int: "∫",
  sqrt: "√",
  ldots: "…",
  dots: "…",
  cdots: "⋯",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  Delta: "Δ",
  epsilon: "ε",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  sigma: "σ",
  Sigma: "Σ",
  theta: "θ",
  omega: "ω",
  percent: "%",
};
const TEXT_COMMANDS = new Set([
  "text",
  "mathrm",
  "mathit",
  "mathbf",
  "mathsf",
  "operatorname",
  "textrm",
  "textit",
  "textbf",
]);
const SPACES = new Set([",", ";", ":", " ", "quad", "qquad"]);

/**
 * A formula's LaTeX source as plain runs, for where it cannot be drawn: a
 * formula inside a sentence of a PDF or a Word file, or one that does not
 * parse. Subscripts and superscripts stay raised and lowered, fractions read
 * "a/b" (in brackets when longer than a word), known commands become their
 * sign; an unknown one keeps its source.
 */
export function formulaRuns(source: string): FormulaRun[] {
  const runs: FormulaRun[] = [];
  let i = 0;
  const push = (text: string, script?: FormulaRun["script"]) => {
    if (!text) return;
    const last = runs.at(-1);
    if (last && last.script === script) last.text += text;
    else runs.push(script ? { text, script } : { text });
  };
  /** A group "{...}" or one token, as source, from position `at`. */
  const groupAt = (at: number): [string, number] => {
    while (source[at] === " ") at += 1;
    if (source[at] === "{") {
      let depth = 0;
      for (let k = at; k < source.length; k += 1) {
        if (source[k] === "\\") {
          k += 1;
          continue;
        }
        if (source[k] === "{") depth += 1;
        else if (source[k] === "}") {
          depth -= 1;
          if (depth === 0) return [source.slice(at + 1, k), k + 1];
        }
      }
      return [source.slice(at + 1), source.length];
    }
    if (source[at] === "\\") {
      const name = /^\\([a-zA-Z]+|.)/.exec(source.slice(at))?.[0] ?? "\\";
      return [name, at + name.length];
    }
    return [source[at] ?? "", at + 1];
  };
  const flat = (part: string) =>
    formulaRuns(part)
      .map((run) => run.text)
      .join("");
  while (i < source.length) {
    const char = source[i]!;
    if (char === "_" || char === "^") {
      const [group, next] = groupAt(i + 1);
      push(flat(group), char === "_" ? "sub" : "sup");
      i = next;
      continue;
    }
    if (char === "{" || char === "}") {
      i += 1;
      continue;
    }
    if (char !== "\\") {
      push(char);
      i += 1;
      continue;
    }
    const name = /^\\([a-zA-Z]+|.)/.exec(source.slice(i))?.[1] ?? "";
    i += name.length + 1;
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const [top, afterTop] = groupAt(i);
      const [bottom, afterBottom] = groupAt(afterTop);
      const wrap = (part: string) =>
        /\s|[+\-·×]/.test(part) ? `(${part})` : part;
      push(`${wrap(flat(top))}/${wrap(flat(bottom))}`);
      i = afterBottom;
    } else if (TEXT_COMMANDS.has(name)) {
      const [group, next] = groupAt(i);
      push(flat(group));
      i = next;
    } else if (name === "left" || name === "right") {
      // The delimiter that follows reads as itself ("\left[" -> "[").
      if (source[i] === "\\") {
        const [delimiter, next] = groupAt(i);
        push(flat(delimiter));
        i = next;
      } else if (source[i] === ".") {
        i += 1;
      }
    } else if (SPACES.has(name)) {
      push(" ");
    } else if (name in SYMBOLS) {
      push(SYMBOLS[name]!);
    } else if (/^[{}%#&_$]$/.test(name)) {
      push(name);
    } else {
      push(`\\${name}`);
    }
  }
  return runs;
}

const cache = new Map<string, string>();
const CACHE_MAX = 500;

/**
 * A formula's LaTeX source as safe HTML: MathML in a `.cx-formula` box when
 * displayed (a formula block), inline otherwise (a formula mark); its escaped
 * source when it does not parse, is too long or comes out unsafe.
 */
export function renderFormula(source: string, display: boolean): string {
  const key = `${display ? "d" : "i"}${source}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  let html: string;
  if (!source.trim()) {
    html = display ? `<div class="cx-formula"></div>` : "";
  } else if (source.length > FORMULA_MAX_LENGTH) {
    html = sourceHtml(source, display);
  } else {
    let markup: string;
    try {
      markup = temml.renderToString(source, {
        ...TEMML_OPTIONS,
        displayMode: display,
      });
    } catch {
      markup = "";
    }
    // Temml marks an unknown command (an untrusted \href) in its error
    // colour: shown as source too.
    if (
      !markup ||
      markup.includes("temml-error") ||
      markup.includes(TEMML_ERROR_COLOUR) ||
      !isSafeMathMl(markup)
    ) {
      html = sourceHtml(source, display);
    } else {
      html = display ? `<div class="cx-formula">${markup}</div>` : markup;
    }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, html);
  return html;
}
