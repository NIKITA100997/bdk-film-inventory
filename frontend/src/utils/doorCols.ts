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
  width: number | null;
  height: number | null;
  thickness: number | null;
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
  const isDoor = /дверь|полотно|\b[А-ЯA-Z]-\d+\b/i.test(rawText);

  let w: number | null = null;
  let h: number | null = null;
  let th: number | null = thicknessMm != null && thicknessMm > 0 ? Math.round(thicknessMm * 10) / 10 : null;

  // 1. Из явных параметров строки
  if (widthMm != null && widthMm > 0) w = Math.round(widthMm);
  if (lengthM != null && lengthM > 0) h = Math.round(lengthM * 1000);

  // 2. Из характеристик (chars)
  if (w == null && by["ширина"]) {
    const num = parseInt(by["ширина"].replace(/\D+/g, ""), 10);
    if (!isNaN(num) && num > 0) w = num;
  }
  if (h == null && by["высота"]) {
    const num = parseInt(by["высота"].replace(/\D+/g, ""), 10);
    if (!isNaN(num) && num > 0) h = num;
  }
  // Для дверных полотен толщину каркаса (22.5 мм и т.п.) не подмешиваем
  if (th == null && by["толщина"] && !isDoor) {
    const num = parseFloat(by["толщина"].replace(/[^\d.,]+/g, "").replace(",", "."));
    if (!isNaN(num) && num > 0) th = Math.round(num * 10) / 10;
  }

  // 3. Из названия строки (partName)
  // 3D: например "22.5х810х2010" или "25.5х50х2010"
  const m3d = rawText.match(/(\d+(?:[.,]\d+)?)\s*[хxXХ*×]\s*(\d+(?:[.,]\d+)?)\s*[хxXХ*×]\s*(\d+(?:[.,]\d+)?)/);
  if (m3d) {
    const d1 = parseFloat(m3d[1].replace(",", "."));
    const d2 = parseFloat(m3d[2].replace(",", "."));
    const d3 = parseFloat(m3d[3].replace(",", "."));
    const sorted = [d1, d2, d3].sort((a, b) => a - b);
    if (th == null && !isDoor) th = Math.round(sorted[0] * 10) / 10;
    if (w == null) w = Math.round(sorted[1]);
    if (h == null) h = Math.round(sorted[2]);
  } else {
    // 2D: например "600х2000" или "300х1850"
    const m2d = rawText.match(/(\d{3,4})\s*[хxXХ*×]\s*(\d{3,4})/);
    if (m2d) {
      const d1 = parseInt(m2d[1], 10);
      const d2 = parseInt(m2d[2], 10);
      if (w == null) w = Math.min(d1, d2);
      if (h == null) h = Math.max(d1, d2);
    }
  }

  let dimsStr = "";
  if (h != null && w != null) {
    dimsStr = th != null ? `${h} × ${w} × ${th} мм` : `${h} × ${w} мм`;
  } else if (m3d) {
    dimsStr = m3d[0].replace(/\s+/g, "");
  }

  const series = by["серия"] || (rawText.match(/([А-ЯA-Z]-\d+)/)?.[1] ?? null);
  const color = by["цвет"] || null;

  return {
    ...edge,
    series: series || null,
    size: dimsStr || null,
    color,
    dimensions_str: dimsStr,
    width: w,
    height: h,
    thickness: th,
  };
}
