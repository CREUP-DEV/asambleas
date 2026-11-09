import { Node, mergeAttributes } from "@tiptap/core";
import { IMAGE_ASSET_PATTERN, IMAGE_URL_PREFIX } from "~~/shared/types/content";

/**
 * An image block (BlockImage) in the editor: a picture stored for the
 * document, on a line of its own, chosen and moved as a whole. It is read
 * back only from the platform's own images (`data-asset`, as the editor
 * writes them), never from an outside address: an image pasted from a web
 * page is left out, and has to be uploaded.
 */

/** Attributes of an image node. */
export interface BlockImageAttrs {
  asset: string;
  width: number;
  height: number;
  alt: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockImage: {
      /** Inserts an image block at the cursor. */
      insertBlockImage: (attrs: BlockImageAttrs) => ReturnType;
    };
  }
}

const positive = (value: string | null): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

export const BlockImageExtension = Node.create({
  name: "blockImage",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    // Read by parseHTML's getAttrs and written by renderHTML below.
    const own = (fallback: string | null) => ({
      default: fallback,
      parseHTML: () => null,
      renderHTML: () => ({}),
    });
    return {
      asset: own(null),
      width: own(null),
      height: own(null),
      alt: own(""),
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[data-asset]",
        getAttrs: (element) => {
          const asset = element.getAttribute("data-asset");
          const width = positive(element.getAttribute("width"));
          const height = positive(element.getAttribute("height"));
          if (!asset || !IMAGE_ASSET_PATTERN.test(asset) || !width || !height) {
            return false;
          }
          return {
            asset,
            width,
            height,
            alt: element.getAttribute("alt") ?? "",
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const asset = String(node.attrs.asset ?? "");
    return [
      "img",
      mergeAttributes(HTMLAttributes, {
        src: IMAGE_ASSET_PATTERN.test(asset)
          ? `${IMAGE_URL_PREFIX}${asset}`
          : "",
        "data-asset": asset,
        alt: node.attrs.alt ?? "",
        width: node.attrs.width,
        height: node.attrs.height,
        class: "cx-editor-image",
        draggable: "false",
      }),
    ];
  },

  addCommands() {
    return {
      insertBlockImage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});
