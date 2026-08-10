/** Нечёткое сравнение строк на клиенте (9.2 раздел бэклога доработок) —
 * лёгкий эквивалент backend-овского find_fuzzy_duplicates (SequenceMatcher)
 * для живой подсказки при вводе, без похода на сервер на каждый символ. */

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

export function stringSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return 1 - levenshteinDistance(na, nb) / Math.max(na.length, nb.length);
}
