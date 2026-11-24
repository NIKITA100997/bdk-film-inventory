import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listMaterialSkus, skuPhotoUrl } from "../api/dictionaries";

/**
 * Хук для быстрого сопоставления текстового названия декора / цвета
 * с актуальным URL фотографии текстуры из каталога плёнок.
 */
export function useDecorPhotoMap(): (decorName?: string | null) => string | null {
  const skusQuery = useQuery({
    queryKey: ["material-skus"],
    queryFn: () => listMaterialSkus(),
    staleTime: 300_000,
  });

  return useMemo(() => {
    const list = skusQuery.data ?? [];
    const directMap = new Map<string, string>();
    const colorOnlyMap = new Map<string, string>();

    for (const s of list) {
      if (!s.photo_path) continue;
      const url = skuPhotoUrl(s.photo_path);
      if (!url) continue;

      const cName = s.color?.name?.toLowerCase().trim();
      const mName = s.manufacturer?.name?.toLowerCase().trim();

      if (cName) {
        if (!colorOnlyMap.has(cName)) colorOnlyMap.set(cName, url);
        if (mName) {
          directMap.set(`${mName} ${cName}`, url);
          directMap.set(`${cName} ${mName}`, url);
        }
      }
    }

    return (decorName?: string | null): string | null => {
      if (!decorName) return null;
      const clean = decorName
        .toLowerCase()
        .replace(/^(пэт|пвх|эмаль|пп)\s+/i, "")
        .replace(/\s+(soft|софт|мат|глянец|2д|3д)$/i, "")
        .trim();

      if (!clean) return null;

      // 1. Точное совпадение по производителю + цвету
      if (directMap.has(clean)) return directMap.get(clean)!;
      if (directMap.has(decorName.toLowerCase().trim())) return directMap.get(decorName.toLowerCase().trim())!;

      // 2. Совпадение по чистому цвету (например, "аляска", "капучино", "венге")
      if (colorOnlyMap.has(clean)) return colorOnlyMap.get(clean)!;

      // 3. Подстрочный поиск (если передано длинное наименование детали или позиции)
      for (const [cKey, url] of colorOnlyMap.entries()) {
        if (cKey.length >= 3 && clean.includes(cKey)) {
          return url;
        }
      }

      return null;
    };
  }, [skusQuery.data]);
}

/**
 * Компактная круглая или скругленная миниатюра текстуры плёнки.
 */
export function DecorThumbnail({
  decor,
  size = 18,
  rounded = true,
  style,
}: {
  decor?: string | null;
  size?: number;
  rounded?: boolean;
  style?: React.CSSProperties;
}) {
  const getPhoto = useDecorPhotoMap();
  const url = getPhoto(decor);

  if (!url) return null;

  return (
    <img
      src={url}
      alt={decor ?? ""}
      title={decor ?? ""}
      style={{
        width: size,
        height: size,
        borderRadius: rounded ? "50%" : 4,
        objectFit: "cover",
        border: "1px solid rgba(0, 0, 0, 0.15)",
        flexShrink: 0,
        verticalAlign: "middle",
        display: "inline-block",
        boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
        ...style,
      }}
    />
  );
}

export default DecorThumbnail;
