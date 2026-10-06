/** Единая нумерация партий (06.10): рулоны/штрипсы плёнки — «ПЛ-1015»,
 * партии п/ф — «ПФ-193». Номера в базе у видов свои и пересекаются (есть и
 * рулон 193, и партия п/ф 193) — префикс сразу говорит, о чём речь.
 * «Р-…» не берём: так называются стеллажи плёнки («Р-3», полка «Р-3-07»).
 * На бирках и в QR — как раньше (рулон — число, партия — «ПФ»+число):
 * старые бирки сканируются без изменений. */
export const FILM_PREFIX = "ПЛ";
export const PF_PREFIX = "ПФ";

export const rollNo = (id: number | string | null | undefined) => (id == null ? "—" : `${FILM_PREFIX}-${id}`);
export const pfNo = (id: number | string | null | undefined) => (id == null ? "—" : `${PF_PREFIX}-${id}`);
export const lotNo = (kind: "plenka" | "pf", id: number | string | null | undefined) => (kind === "plenka" ? rollNo(id) : pfNo(id));

/** «ПЛ-1015», «пл1015», «ПЛ 1015» → рулон 1015; «ПФ-193», «пф193» → партия п/ф 193. */
export function parseLotNo(text: string): { kind: "plenka" | "pf"; id: number } | null {
  const m = text.trim().match(/^(ПЛ|ПФ)[\s-]*(\d+)$/i);
  if (!m) return null;
  return { kind: m[1].toUpperCase() === FILM_PREFIX ? "plenka" : "pf", id: Number(m[2]) };
}
