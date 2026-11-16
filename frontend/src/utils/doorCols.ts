import type { ItemChar } from "../components/ItemChars";

const THICK_RE = /(\d+(?:[.,]\d+)?)\s*мм/i;
const SIDES_RE = /(?<!\d)([24])\s*-?\s*(?:х|x|сторон\w*)/i;

export interface DoorEdgeInfo {
  edge_type: string | null;
  edge_color: string | null;
  edge_sides: number | null;
  edge_label: string | null;
}

export interface DoorColsInfo extends DoorEdgeInfo {
  series: string | null;
  size: string | null;
  color: string | null;
  dimensions_str: string;
}

export function parseEdgeInfo(chars?: ItemChar[] | null, text?: string | null): DoorEdgeInfo {
  const by: Record<string, string> = {};
  for (const c of chars ?? []) {
    by[c.code] = c.value;
  }

  const rawText = text || "";
  const sidesMatch = rawText.match(SIDES_RE);
  const sides = sidesMatch ? parseInt(sidesMatch[1], 10) : null;

  const kind = (by["кромка"] || "").toLowerCase();
  const color = (by["цвет_кромки"] || "").trim();

  if (!kind && !color) {
    const edgeMatch = rawText.match(/кромк[а-я]*\s+([^,;]+)/i);
    let edgeRaw = edgeMatch ? edgeMatch[1].trim() : "";
    if (!edgeRaw && (/алюм/i.test(rawText) || /alum/i.test(rawText))) {
      edgeRaw = "алюминий";
    }
    if (!edgeRaw) {
      return { edge_type: null, edge_color: null, edge_sides: sides, edge_label: null };
    }

    const thMatch = edgeRaw.match(THICK_RE);
    const thVal = thMatch ? thMatch[1].replace(".", ",") : "";
    const isPet = /\bпэт\b|\bpet\b/i.test(edgeRaw);
    const isAlum = /алюм|alum/i.test(edgeRaw);
    const isAbs = /\babs\b|\bабс\b/i.test(edgeRaw);

    let edgeType = "ABS";
    if (isAlum) edgeType = "алюминий";
    else if (isPet) edgeType = thVal ? `ПЭТ ${thVal} мм` : "ПЭТ";
    else if (isAbs || thVal) edgeType = thVal ? `ABS ${thVal} мм` : "ABS";

    let colorClean = edgeRaw
      .replace(/\babs\b|\bабс\b|\bпэт\b|\bpet\b|алюмин\w*|alum\w*/gi, "")
      .replace(/\d+(?:[.,]\d+)?\s*мм/gi, "")
      .replace(/(?:с\s*)?\d\s*-?\s*(?:х|x|сторон\w*)/gi, "")
      .trim();

    const labelParts = [edgeType, colorClean, sides ? `${sides}х` : null].filter(Boolean);
    return {
      edge_type: edgeType,
      edge_color: colorClean || null,
      edge_sides: sides,
      edge_label: labelParts.join(" · ") || null,
    };
  }

  if (kind.includes("алюм") || kind.includes("alum")) {
    const labelParts = ["алюминий", color, sides ? `${sides}х` : null].filter(Boolean);
    return {
      edge_type: "алюминий",
      edge_color: color || null,
      edge_sides: sides,
      edge_label: labelParts.join(" · ") || null,
    };
  }

  const thMatch = color.match(THICK_RE);
  const isPet = /пэт|pet/i.test(color);
  const base = isPet ? "ПЭТ" : "ABS";
  const edgeType = thMatch ? `${base} ${thMatch[1].replace(".", ",")} мм` : base;
  const cleanColor = color
    .replace(/\babs\b|пэт|\bpet\b/gi, " ")
    .replace(THICK_RE, " ")
    .trim();

  const labelParts = [edgeType, cleanColor, sides ? `${sides}х` : null].filter(Boolean);
  return {
    edge_type: edgeType,
    edge_color: cleanColor || null,
    edge_sides: sides,
    edge_label: labelParts.join(" · ") || null,
  };
}

export function extractDoorCols(
  chars?: ItemChar[] | null,
  partName?: string | null,
  lengthM?: number | null,
  widthMm?: number | null,
  thicknessMm?: number | null,
): DoorColsInfo {
  const by: Record<string, string> = {};
  for (const c of chars ?? []) {
    by[c.code] = c.value;
  }

  const rawText = partName || "";
  const edge = parseEdgeInfo(chars, rawText);

  // Размеры: приоритет явным колонкам length_m / width_mm / thickness
  let dimsStr = "";
  if (lengthM != null && widthMm != null && lengthM > 0 && widthMm > 0) {
    const len = Math.round(lengthM * 1000);
    const w = Math.round(widthMm);
    const th = thicknessMm ? `${Math.round(thicknessMm * 10) / 10}` : null;
    dimsStr = th ? `${len} × ${w} × ${th} мм` : `${len} × ${w} мм`;
  } else if (by["ширина"] && by["высота"]) {
    const w = by["ширина"].replace(/\s*мм$/, "");
    const h = by["высота"].replace(/\s*мм$/, "");
    const t = by["толщина"] ? by["толщина"].replace(/\s*мм$/, "") : null;
    dimsStr = t ? `${h} × ${w} × ${t} мм` : `${h} × ${w} мм`;
  } else {
    const m = rawText.match(/(\d+(?:[.,]\d+)?\s*[хxXХ*×]\s*\d+(?:\s*[хxXХ*×]\s*\d+)?)/);
    dimsStr = m ? m[1].replace(/\s+/g, "") : "";
  }

  const series =
    by["серия"] ||
    (rawText.match(/([А-ЯA-Z]-\d+)/)?.[1] ?? null);

  const color = by["цвет"] || null;

  return {
    ...edge,
    series: series || null,
    size: dimsStr || null,
    color,
    dimensions_str: dimsStr,
  };
}
