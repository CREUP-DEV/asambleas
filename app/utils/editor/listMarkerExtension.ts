import { Extension } from "@tiptap/core";
import { isListMarker } from "~~/shared/utils/content/lists";
import type { ListMarker } from "~~/shared/types/content";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    listMarker: {
      /** Sets the marker of the innermost ordered list around the cursor. */
      setListMarker: (marker: ListMarker) => ReturnType;
    };
  }
}

/**
 * Keeps an ordered list's marker ("a)", "I.") as a `marker` attribute,
 * written as `data-marker` like the rendered content, so the editor numbers
 * lists as the document does. TipTap's own `start` keeps the first number.
 * shared/utils/content/editor.ts checks the value against LIST_MARKERS.
 */
export const ListMarkerExtension = Extension.create({
  name: "listMarker",
  addGlobalAttributes() {
    return [
      {
        types: ["orderedList"],
        attributes: {
          marker: {
            default: null,
            parseHTML: (element) => element.getAttribute("data-marker"),
            renderHTML: (attributes) =>
              attributes.marker ? { "data-marker": attributes.marker } : {},
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setListMarker:
        (marker) =>
        ({ tr, dispatch }) => {
          if (!isListMarker(marker)) return false;
          // Only the list the cursor is in, not the lists around it.
          const { $from } = tr.selection;
          for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (node.type.name !== "orderedList") continue;
            if (dispatch) {
              tr.setNodeMarkup($from.before(depth), undefined, {
                ...node.attrs,
                marker: marker === "1." ? null : marker,
              });
            }
            return true;
          }
          return false;
        },
    };
  },
});
