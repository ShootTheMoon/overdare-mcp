/**
 * Property shapes for instance.create / instance.update.
 *
 * Two things about the wire format are easy to get wrong and fail silently,
 * which is why this exists rather than passing objects through untouched:
 *
 * 1. Properties go **flat** on the instance object. Nesting them under a
 *    `Properties` key does not error — the server answers success and reports
 *    "Properties is not a valid property of Frame" in `message`, having ignored
 *    every value you sent.
 *
 * 2. Composite values are tagged objects, and UDim2 spells its second axis with
 *    a **lower-case `y`**. An upper-case `Y` is dropped without comment, so a
 *    Size written that way comes back half-applied.
 *
 * Writing those by hand is verbose enough that it invites mistakes, so the
 * common ones also accept an array short form:
 *
 *   Size: [0.5, 10, 0, 64]        -> UDim2   [xScale, xOffset, yScale, yOffset]
 *   BackgroundColor3: [20, 180, 90] -> Color3 (0-255, not 0-1)
 *   AnchorPoint: [0.5, 1]         -> Vector2
 *   FillCornerRadius: [0, 8]      -> UDim    [scale, offset]
 *   SliceCenter: [12, 12, 20, 20] -> Rect
 *   FontFace: { Family, Style?, Weight? } -> Font
 *
 * Anything already carrying an `ObjectType` passes through untouched.
 */

type Json = Record<string, unknown>;

const UDIM2 = new Set(["Position", "Size", "CanvasSize", "CanvasPosition"]);
const VECTOR2 = new Set(["AnchorPoint", "CellSize", "CellPadding"]);
const COLOR3 = new Set([
  "BackgroundColor3",
  "BorderColor3",
  "TextColor3",
  "ImageColor3",
  "FillColor3",
  "TrackColor3",
  "Color",
  "ScrollBarImageColor3",
]);
const UDIM = new Set([
  "FillCornerRadius",
  "TrackCornerRadius",
  "BorderOffset",
  "Padding",
]);
const RECT = new Set(["SliceCenter"]);

const isNums = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === "number");

export function coerce(name: string, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "object" && !Array.isArray(v) && "ObjectType" in (v as Json)) return v;

  if (UDIM2.has(name) && isNums(v, 4)) {
    const [xs, xo, ys, yo] = v;
    return {
      ObjectType: "UDim2",
      X: { ObjectType: "UDim", Scale: xs, Offset: xo },
      y: { ObjectType: "UDim", Scale: ys, Offset: yo },
    };
  }
  if (VECTOR2.has(name) && isNums(v, 2)) return { ObjectType: "Vector2", X: v[0], Y: v[1] };
  if (COLOR3.has(name) && isNums(v, 3)) return { ObjectType: "Color3", R: v[0], G: v[1], B: v[2] };
  if (UDIM.has(name) && isNums(v, 2)) return { ObjectType: "UDim", Scale: v[0], Offset: v[1] };
  if (RECT.has(name) && isNums(v, 4))
    return { ObjectType: "Rect", MinX: v[0], MinY: v[1], MaxX: v[2], MaxY: v[3] };
  if (name === "FontFace" && typeof v === "object" && !Array.isArray(v)) {
    const f = v as Json;
    return {
      ObjectType: "Font",
      Family: f.Family ?? "",
      Style: f.Style ?? "Normal",
      // The boolean `Bold` this replaced no longer exists on TextLabel.
      Weight: f.Weight ?? "Regular",
    };
  }
  return v;
}

/** Expand a props object into the flat, tagged form the engine reads. */
export function flatten(props: Json | undefined): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(props ?? {})) out[k] = coerce(k, v);
  return out;
}

/**
 * Classes this build does not register. Creating one is not an error — the call
 * succeeds and simply returns fewer GUIDs than instances asked for — so callers
 * need the list to explain the gap.
 */
export const ABSENT_CLASSES = [
  "UICorner",
  "UIGradient",
  "UIPadding",
  "UISizeConstraint",
  "UITextSizeConstraint",
  "ViewportFrame",
  "TextBox",
  "CanvasGroup",
  "VideoFrame",
];
