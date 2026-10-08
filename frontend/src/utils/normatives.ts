/** Партия к пополнению — как backend services/normatives.round_batch:
 * не меньше мин. партии, вверх до кратного (08.10). */
export function roundBatch(qty: number, minBatch?: number | null, multiple?: number | null): number {
  if (qty <= 0) return 0;
  let q = Math.max(qty, minBatch ?? 0);
  if (multiple && multiple > 0) q = Math.ceil(Math.round((q / multiple) * 1e9) / 1e9) * multiple;
  return Math.round(q * 1000) / 1000;
}

/** «мин. 50 · партия от 20 · кратно 3,6» — коротко для таблиц. */
export function normsLabel(minStock?: number | null, minBatch?: number | null, multiple?: number | null): string {
  const f = (n: number) => String(Math.round(n * 1000) / 1000).replace(".", ",");
  const parts = [
    minStock != null ? `мин. ${f(minStock)}` : null,
    minBatch != null ? `партия от ${f(minBatch)}` : null,
    multiple != null ? `кратно ${f(multiple)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}
