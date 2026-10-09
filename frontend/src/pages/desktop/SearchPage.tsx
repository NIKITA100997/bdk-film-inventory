import { useEffect, useState } from "react";
import { Alert, Button, Card, Empty, Input, List, Space, Spin, Tag, Typography } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { apiClient } from "../../api/client";
import { useTabTitle } from "../../layout/tabTitle";

/** Общий поиск по названию (09.10): строка в шапке ведёт сюда с любым
 * текстом, который не номер и не код стеллажа. Позиции номенклатуры,
 * задания цеха и заказы — по названию детали, строкам, номеру счёта. */

interface TextHit {
  kind: "item" | "task" | "order";
  id: number;
  title: string;
  subtitle: string | null;
  active: boolean;
}

interface TextSearchOut {
  query: string;
  items: TextHit[];
  tasks: TextHit[];
  orders: TextHit[];
  truncated: boolean;
}

const HREF: Record<TextHit["kind"], (id: number) => string> = {
  item: (id) => `/item/${id}`,
  task: (id) => `/production-tasks?task=${id}`,
  order: (id) => `/production-orders/${id}`,
};

function HitList({ title, hits }: { title: string; hits: TextHit[] }) {
  if (hits.length === 0) return null;
  return (
    <Card size="small" title={`${title} · ${hits.length}`}>
      <List
        size="small"
        dataSource={hits}
        renderItem={(h) => (
          <List.Item>
            <Space direction="vertical" size={0} style={{ minWidth: 0 }}>
              <Space size={6} wrap>
                <Link to={HREF[h.kind](h.id)}>{h.title}</Link>
                {!h.active && <Tag>{h.kind === "order" ? "закрыт" : h.kind === "task" ? "в архиве" : "не используется"}</Tag>}
              </Space>
              {h.subtitle && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {h.subtitle}
                </Typography.Text>
              )}
            </Space>
          </List.Item>
        )}
      />
    </Card>
  );
}

export default function SearchPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const q = (params.get("q") ?? "").trim();
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  useTabTitle(q ? `Поиск: ${q}` : "Поиск");

  const query = useQuery({
    queryKey: ["search-text", q],
    queryFn: async () => (await apiClient.get<TextSearchOut>("/search", { params: { q } })).data,
    enabled: q.length >= 2,
  });
  const data = query.data;
  const total = data ? data.items.length + data.tasks.length + data.orders.length : 0;

  return (
    <Space direction="vertical" size={12} style={{ width: "100%", maxWidth: 960 }}>
      <Input.Search
        allowClear
        enterButton={<SearchOutlined />}
        placeholder="Название детали, позиции, задания, заказа или номер счёта"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onSearch={(v) => v.trim() && navigate(`/search?q=${encodeURIComponent(v.trim())}`, { replace: true })}
      />
      {q.length < 2 ? (
        <Typography.Text type="secondary">Введите хотя бы два символа. Слова ищутся все, в любом порядке: «стоевая 1976», «каркас 810х2010», «1726-ВД».</Typography.Text>
      ) : query.isLoading ? (
        <Spin />
      ) : query.isError ? (
        <Alert type="error" showIcon message="Поиск не выполнился — проверьте связь с сервером и повторите." />
      ) : (
        <>
          {data?.truncated && (
            <Alert type="info" showIcon message="Найдено много — показаны первые 50 в каждом разделе. Уточните запрос: добавьте размер или серию." />
          )}
          {total === 0 && <Empty description={`По «${q}» ничего не найдено`} />}
          <HitList title="Номенклатура" hits={data?.items ?? []} />
          <HitList title="Задания цеха" hits={data?.tasks ?? []} />
          <HitList title="Заказы на производство" hits={data?.orders ?? []} />
          <Button type="link" style={{ padding: 0, alignSelf: "flex-start" }} onClick={() => navigate("/stock", { state: { globalQuery: q } })}>
            Искать «{q}» в остатках плёнки →
          </Button>
        </>
      )}
    </Space>
  );
}
