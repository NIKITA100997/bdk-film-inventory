import { Suspense, lazy, type ComponentType } from "react";
import { Spin } from "antd";

const RELOAD_KEY = "bdk-chunk-reload";

/** Страница, которая загружается при первом открытии (14.10): интерфейс
 * больше не приходит одним файлом — на слабом Wi-Fi цеха первая загрузка
 * в разы легче. Индикатор — на месте страницы, шапка и вкладки не мигают. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- страницы с разными свойствами
export function lazyPage(load: () => Promise<{ default: ComponentType<any> }>) {
  // После выкладки у открытой вкладки старые имена файлов: файл экрана уже
  // удалён — один раз перезагрузить страницу на новую версию, а не показать ошибку.
  const C = lazy(() =>
    load().then(
      (m) => {
        try {
          sessionStorage.removeItem(RELOAD_KEY);
        } catch {
          /* хранилище недоступно — не страшно */
        }
        return m;
      },
      (err) => {
        let reloaded = false;
        try {
          reloaded = sessionStorage.getItem(RELOAD_KEY) === "1";
          if (!reloaded) sessionStorage.setItem(RELOAD_KEY, "1");
        } catch {
          reloaded = true;
        }
        if (!reloaded) window.location.reload();
        throw err;
      },
    ),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function LazyPage(props: any) {
    return (
      <Suspense
        fallback={
          <div style={{ padding: 32, display: "flex", justifyContent: "center" }}>
            <Spin />
          </div>
        }
      >
        <C {...props} />
      </Suspense>
    );
  };
}
