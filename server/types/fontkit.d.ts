/**
 * The part of fontkit's API the PDF letterhead uses: laying out a line of
 * text and reading its glyph outlines. fontkit ships no types.
 */
declare module "fontkit" {
  export interface Path {
    scale(scaleX: number, scaleY: number): Path;
    translate(x: number, y: number): Path;
    toSVG(): string;
  }

  export interface Glyph {
    path: Path;
  }

  export interface GlyphPosition {
    xAdvance: number;
    xOffset: number;
    yOffset: number;
  }

  export interface GlyphRun {
    glyphs: Glyph[];
    positions: GlyphPosition[];
  }

  export interface Font {
    unitsPerEm: number;
    layout(text: string): GlyphRun;
  }

  export function create(buffer: Buffer): Font;
}
