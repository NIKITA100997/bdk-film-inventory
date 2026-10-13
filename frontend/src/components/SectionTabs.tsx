import { Card, Tabs } from "antd";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";

export interface Section {
  key: string;
  label: string;
  children: React.ReactNode;
}

/** Экран-объединение (14.10, наведение порядка в меню): несколько прежних
 * экранов — вкладками одного пункта. Вкладка — параметр section, чтобы не
 * мешать собственным параметрам экранов (tab, week…). */
export default function SectionTabs({ title, sections }: { title: string; sections: Section[] }) {
  const [params, setParams] = useSearchParams();
  const wanted = params.get("section") ?? params.get("tab"); // старые ссылки вида ?tab=bitrix
  const active = sections.some((s) => s.key === wanted) ? (wanted as string) : sections[0]?.key;
  if (sections.length === 0) return null;
  return (
    <Card title={title}>
      <Tabs
        activeKey={active}
        onChange={(k) => setParams(new URLSearchParams({ section: k }), { replace: true })}
        items={sections}
        destroyOnHidden
      />
    </Card>
  );
}

/** Старый адрес → вкладка нового экрана; параметры адреса сохраняются. */
export function RedirectToSection({ to, section }: { to: string; section: string }) {
  const location = useLocation();
  const p = new URLSearchParams(location.search);
  p.set("section", section);
  return <Navigate to={`${to}?${p.toString()}`} replace />;
}
