import {
  Math as WordMath,
  MathAngledBrackets,
  MathCurlyBrackets,
  MathFraction,
  MathIntegral,
  MathRadical,
  MathRoundBrackets,
  MathRun,
  MathSquareBrackets,
  MathSubScript,
  MathSubSuperScript,
  MathSum,
  MathSuperScript,
} from "docx";
import { parseHTML } from "linkedom";
import temml from "temml";
import {
  FORMULA_MAX_LENGTH,
  isSafeMathMl,
} from "../../../shared/utils/content/formula";

/**
 * A formula as a native Word equation (user's decision of 2026-11-20): its
 * LaTeX source read by Temml into MathML, and that MathML walked into the
 * `docx` library's equation parts (fractions, scripts, radicals, sums,
 * integrals, brackets). What has no part of its own reads as its text, so
 * nothing is lost. Null when the source does not parse: the caller writes
 * it as text instead (formulaRuns).
 */

type MathPart = ConstructorParameters<typeof WordMath>[0]["children"][number];

const BRACKETS: Record<string, (children: MathPart[]) => MathPart> = {
  "(": (children) => new MathRoundBrackets({ children }),
  "[": (children) => new MathSquareBrackets({ children }),
  "{": (children) => new MathCurlyBrackets({ children }),
  "⟨": (children) => new MathAngledBrackets({ children }),
};

function elements(node: Element): Element[] {
  return Array.from(node.children).filter(
    (child) => child.tagName.toLowerCase() !== "annotation",
  );
}

function text(node: Element): string {
  return (node.textContent ?? "").replace(/⁡|⁢|⁣/g, "");
}

function parts(nodes: Element[]): MathPart[] {
  const out: MathPart[] = [];
  let i = 0;
  while (i < nodes.length) {
    const node = nodes[i]!;
    // A fenced group ("\left( … \right)"): the bracket and what it holds.
    if (
      node.tagName.toLowerCase() === "mo" &&
      node.getAttribute("fence") === "true" &&
      node.getAttribute("form") === "prefix" &&
      BRACKETS[text(node)]
    ) {
      const close = nodes.findIndex(
        (other, k) =>
          k > i &&
          other.tagName.toLowerCase() === "mo" &&
          other.getAttribute("fence") === "true" &&
          other.getAttribute("form") === "postfix",
      );
      if (close > i) {
        out.push(BRACKETS[text(node)]!(parts(nodes.slice(i + 1, close))));
        i = close + 1;
        continue;
      }
    }
    out.push(...part(node));
    i += 1;
  }
  return out;
}

function part(node: Element): MathPart[] {
  const tag = node.tagName.toLowerCase();
  const kids = elements(node);
  const at = (index: number) => (kids[index] ? part(kids[index]!) : []);
  switch (tag) {
    case "math":
    case "semantics":
    case "mrow":
    case "mstyle":
    case "mpadded":
      return parts(kids);
    case "mfrac":
      return [new MathFraction({ numerator: at(0), denominator: at(1) })];
    case "msub":
      return [new MathSubScript({ children: at(0), subScript: at(1) })];
    case "msup":
      return [new MathSuperScript({ children: at(0), superScript: at(1) })];
    case "msubsup":
    case "munderover": {
      const base = text(kids[0] ?? node).trim();
      if (base === "∑") {
        return [
          new MathSum({ children: [], subScript: at(1), superScript: at(2) }),
        ];
      }
      if (base === "∫") {
        return [
          new MathIntegral({
            children: [],
            subScript: at(1),
            superScript: at(2),
          }),
        ];
      }
      return [
        new MathSubSuperScript({
          children: at(0),
          subScript: at(1),
          superScript: at(2),
        }),
      ];
    }
    case "msqrt":
      return [new MathRadical({ children: parts(kids) })];
    case "mroot":
      return [new MathRadical({ children: at(0), degree: at(1) })];
    case "mspace":
      return [new MathRun(" ")];
    case "mi":
    case "mn":
    case "mo":
    case "mtext":
    case "ms": {
      const value = text(node);
      return value ? [new MathRun(value)] : [];
    }
    default: {
      // No part of its own (an accent, a table): what it reads.
      const value = text(node);
      return value ? [new MathRun(value)] : [];
    }
  }
}

/** A formula's source as a Word equation, or null when it does not parse. */
export function formulaToDocx(
  source: string,
  display: boolean,
): WordMath | null {
  if (!source.trim() || source.length > FORMULA_MAX_LENGTH) return null;
  let markup: string;
  try {
    markup = temml.renderToString(source, {
      displayMode: display,
      trust: false,
      throwOnError: false,
      strict: false,
      maxSize: [20, 20],
      maxExpand: 300,
    });
  } catch {
    return null;
  }
  if (markup.includes("temml-error") || !isSafeMathMl(markup)) return null;
  const { document } = parseHTML(
    `<!doctype html><html><body>${markup}</body></html>`,
  );
  const math = document.querySelector("math");
  if (!math) return null;
  const children = part(math as unknown as Element);
  return children.length > 0 ? new WordMath({ children }) : null;
}
