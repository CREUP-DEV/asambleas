import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/base/BaseConfiguration.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/noundefined/NoUndefinedConfiguration.js";
import { FORMULA_MAX_LENGTH } from "../../../shared/utils/content/formula";

/**
 * A displayed formula for the PDF (user's decision of 2026-11-20): its
 * LaTeX source drawn by MathJax as SVG paths, which pdfmake lays out like
 * the band down the page's edge. Built where the PDF definition is built
 * (the export worker), so the definition stays plain JSON.
 *
 * Only the base and AMS macros: no \href, \class or HTML. A source that
 * does not parse, or is too long, has no SVG and prints as text instead.
 */

/** Points per ex of MathJax's output at the text's size (11 pt). */
const PT_PER_EX = 4.9;

let convert: ((source: string) => string) | null = null;

function converter(): (source: string) => string {
  if (convert) return convert;
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document("", {
    InputJax: new TeX({ packages: ["base", "ams", "noundefined"] }),
    OutputJax: new SVG({ fontCache: "none" }),
  });
  convert = (source) =>
    adaptor.innerHTML(document.convert(source, { display: true }));
  return convert;
}

export interface FormulaSvg {
  svg: string;
  /** Its size in points. */
  width: number;
  height: number;
}

const cache = new Map<string, FormulaSvg | null>();
const CACHE_MAX = 200;

function exToPt(value: string | undefined): number | null {
  const match = /^([\d.]+)ex$/.exec(value ?? "");
  return match ? Number(match[1]) * PT_PER_EX : null;
}

/** The SVG of a displayed formula, or null when it cannot be drawn. */
export function formulaSvg(source: string): FormulaSvg | null {
  const known = cache.get(source);
  if (known !== undefined) return known;
  let result: FormulaSvg | null = null;
  if (source.trim() && source.length <= FORMULA_MAX_LENGTH) {
    try {
      const svg = converter()(source);
      const width = exToPt(/ width="([^"]+)"/.exec(svg)?.[1]);
      const height = exToPt(/ height="([^"]+)"/.exec(svg)?.[1]);
      if (!svg.includes('data-mml-node="merror"') && width && height) {
        result = {
          // pdfmake's SVG reader knows no currentColor: the text's black.
          svg: svg.replace(/currentColor/g, "#000000"),
          width,
          height,
        };
      }
    } catch {
      result = null;
    }
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(source, result);
  return result;
}
