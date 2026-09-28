import { createContext, useContext, useEffect } from "react";

/** Название своей вкладки из экрана («Дверь щитовая В-9 600х2000…» вместо
 * «Позиция №412»). Вне вкладок (телефон) — ничего не делает. */
export const TabTitleContext = createContext<((title: string | null) => void) | null>(null);

export function useTabTitle(title: string | null | undefined): void {
  const setTitle = useContext(TabTitleContext);
  useEffect(() => {
    setTitle?.(title ?? null);
  }, [setTitle, title]);
}
