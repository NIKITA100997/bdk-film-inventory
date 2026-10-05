import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Tabs } from "antd";
import {
  createRoutesFromChildren,
  useLocation,
  useNavigate,
  useNavigationType,
  useRoutes,
  type Location,
  type RouteObject,
} from "react-router-dom";
import { navTree } from "./navConfig";
import { TabTitleContext } from "./tabTitle";

/** Рабочие вкладки, как в 1С: каждый открытый экран или карточка — своя
 * вкладка под меню, её можно переключить или закрыть. Вкладки не
 * пересоздаются при переключении — у списка остаются фильтры, выбор и
 * прокрутка (раньше карточка открывалась вместо списка, и вернуться можно
 * было только со сбросом).
 *
 * Правила: переход по меню или ссылке на другой экран — новая вкладка
 * (или уже открытая с тем же экраном); смена параметров внутри экрана
 * (?tab=…) — та же вкладка; переход с заменой (перенаправление, например
 * /materials → карточка позиции) — заменяет текущую вкладку. */

// 8 (05.10, было 12): на планшете больше не помещается, остальное уходило в «…»
const MAX_TABS = 8;
const STORAGE_KEY = "bdk-workspace-tabs";

interface Tab {
  key: string;
  location: Location;
  title: string | null;
  lastUsed: number;
  mounted: boolean;
}

/** Ключ вкладки: экран = путь; карточка по state (рулон/партия) — ещё и её номер. */
function tabKey(location: Location): string {
  const unitId = (location.state as { unitId?: number } | null)?.unitId;
  return unitId != null ? `${location.pathname}#${unitId}` : location.pathname;
}

const menuTitles: { path: string; pathname: string; label: string }[] = navTree.flatMap((b) =>
  b.items.map((i) => ({ path: i.path, pathname: i.path.split("?")[0], label: i.label })),
);

function defaultTitle(location: Location): string {
  const exact = menuTitles.find((m) => m.path === location.pathname + location.search);
  if (exact) return exact.label;
  const byPath = menuTitles.find((m) => m.pathname === location.pathname);
  if (byPath) return byPath.label;
  const unitId = (location.state as { unitId?: number } | null)?.unitId;
  if (location.pathname === "/m/unit-card") return unitId != null ? `Единица №${unitId}` : "Карточка единицы";
  if (location.pathname === "/m/part-unit-card") return unitId != null ? `Партия п/ф №${unitId}` : "Карточка партии п/ф";
  const item = location.pathname.match(/^\/item\/(\d+)/);
  if (item) return `Позиция №${item[1]}`;
  return location.pathname;
}

function restoreTabs(): Tab[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw) as { location: Location; title: string | null }[];
    return saved.map((t, i) => ({ key: tabKey(t.location), location: t.location, title: t.title, lastUsed: i, mounted: false }));
  } catch {
    return [];
  }
}

function saveTabs(tabs: Tab[]): void {
  try {
    const plain = tabs.map((t) => ({
      location: { pathname: t.location.pathname, search: t.location.search, hash: t.location.hash, state: t.location.state, key: t.location.key },
      title: t.title,
    }));
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(plain));
  } catch {
    /* хранилище недоступно — вкладки просто не переживут перезагрузку */
  }
}

function TabPane({ routes, location, active }: { routes: RouteObject[]; location: Location; active: boolean }) {
  const element = useRoutes(routes, location);
  return (
    <div
      role="tabpanel"
      aria-hidden={!active}
      style={{ display: active ? "block" : "none", height: "100%", overflow: "auto", padding: 24, minWidth: 0 }}
    >
      {element}
    </div>
  );
}

export default function WorkspaceTabs({ pageRoutes }: { pageRoutes: ReactNode }) {
  const routes = useMemo(() => createRoutesFromChildren(pageRoutes), [pageRoutes]);
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<Tab[]>(restoreTabs);
  const activeKey = tabKey(location);
  const prevKey = useRef<string | null>(null);

  // Адрес браузера — источник правды: активная вкладка — та, чей ключ у
  // текущего адреса; новый ключ — новая вкладка (или замена при REPLACE).
  useEffect(() => {
    const now = Date.now();
    setTabs((prev) => {
      const existing = prev.find((t) => t.key === activeKey);
      let next: Tab[];
      if (existing) {
        next = prev.map((t) => (t.key === activeKey ? { ...t, location, lastUsed: now, mounted: true } : t));
        // Старый адрес перенаправил на уже открытую вкладку (/part-units →
        // /stock) — вкладка самого перенаправления больше не нужна.
        if (navigationType === "REPLACE" && prevKey.current && prevKey.current !== activeKey) {
          next = next.filter((t) => t.key !== prevKey.current);
        }
      } else if (navigationType === "REPLACE" && prevKey.current && prev.some((t) => t.key === prevKey.current)) {
        next = prev.map((t) =>
          t.key === prevKey.current ? { key: activeKey, location, title: null, lastUsed: now, mounted: true } : t,
        );
      } else {
        next = [...prev, { key: activeKey, location, title: null, lastUsed: now, mounted: true }];
      }
      while (next.length > MAX_TABS) {
        const oldest = next.filter((t) => t.key !== activeKey).sort((a, b) => a.lastUsed - b.lastUsed)[0];
        next = next.filter((t) => t !== oldest);
      }
      return next;
    });
    prevKey.current = activeKey;
  }, [location, activeKey, navigationType]);

  useEffect(() => saveTabs(tabs), [tabs]);

  // Сеттер названия на каждую вкладку — пересоздаются только при смене набора вкладок.
  const keysSig = JSON.stringify(tabs.map((t) => t.key));
  const titleSetters = useMemo(
    () =>
      new Map(
        (JSON.parse(keysSig) as string[]).map((key) => [
          key,
          (title: string | null) =>
            setTabs((prev) =>
              prev.find((x) => x.key === key)?.title === title ? prev : prev.map((x) => (x.key === key ? { ...x, title } : x)),
            ),
        ]),
      ),
    [keysSig],
  );

  const go = (tab: Tab) =>
    navigate({ pathname: tab.location.pathname, search: tab.location.search, hash: tab.location.hash }, { state: tab.location.state });

  const close = (key: string) => {
    const rest = tabs.filter((t) => t.key !== key);
    if (rest.length === 0) return;
    setTabs(rest);
    if (key === activeKey) go([...rest].sort((a, b) => b.lastUsed - a.lastUsed)[0]);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <Tabs
        type="editable-card"
        hideAdd
        size="small"
        activeKey={activeKey}
        onChange={(key) => {
          const tab = tabs.find((t) => t.key === key);
          if (tab) go(tab);
        }}
        onEdit={(key, action) => action === "remove" && typeof key === "string" && close(key)}
        items={tabs.map((t) => ({
          key: t.key,
          closable: tabs.length > 1,
          label: (
            <span
              title={t.title ?? defaultTitle(t.location)}
              style={{ display: "inline-block", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", verticalAlign: "bottom" }}
            >
              {t.title ?? defaultTitle(t.location)}
            </span>
          ),
        }))}
        tabBarExtraContent={
          tabs.length > 2 ? (
            <Button size="small" type="text" title="Закрыть все вкладки, кроме текущей" onClick={() => setTabs((prev) => prev.filter((t) => t.key === activeKey))}>
              Закрыть остальные
            </Button>
          ) : undefined
        }
        tabBarStyle={{ margin: 0, padding: "6px 8px 0" }}
        style={{ flexShrink: 0 }}
      />
      <div style={{ flex: "1 1 auto", minHeight: 0, position: "relative" }}>
        {tabs
          .filter((t) => t.mounted)
          .map((t) => (
            <TabTitleContext.Provider key={t.key} value={titleSetters.get(t.key) ?? null}>
              <TabPane routes={routes} location={t.location} active={t.key === activeKey} />
            </TabTitleContext.Provider>
          ))}
      </div>
    </div>
  );
}
