import { useState } from "react";
import { Button, Card, Empty, Input, List, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { findBitrixDeals, setBitrixDeal, type CustomerOrder } from "../../../api/customerOrders";
import { DIRECTIONS } from "../../../utils/itemAttrs";
import { apiErrorMessage } from "../../../utils/apiError";

const WHOLE = "";

/** Сделки Битрикс24 у заказа клиента (20.10: по видам). В Битриксе на один
 * счёт — сделка на вид продукции («пог. 3220 шт», «щиты», «царга»); у
 * заказа их может быть несколько: каждая ведёт свои строки и сама идёт по
 * стадиям за их готовностью. Или одна сделка на весь заказ. Привязываются
 * сами (по счёту и виду в названии) или вручную; недостающие — создаются. */
export default function BitrixDealCard({ order, canEdit }: { order: CustomerOrder; canEdit: boolean }) {
  const qc = useQueryClient();
  const [pick, setPick] = useState(false);
  const [manual, setManual] = useState("");
  const [dir, setDir] = useState<string | undefined>(undefined); // нет — по названию сделки
  const found = useQuery({ queryKey: ["bitrix-deals", order.id], queryFn: () => findBitrixDeals(order.id), enabled: pick, retry: false });
  const set = useMutation({
    mutationFn: (p: { deal?: string; create?: boolean; unlink?: boolean; direction?: string | null }) => setBitrixDeal(order.id, p),
    onSuccess: (_, p) => {
      qc.invalidateQueries({ queryKey: ["customer-order", order.id] });
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      qc.invalidateQueries({ queryKey: ["bitrix-deals", order.id] });
      setManual("");
      message.success(p.unlink ? "Сделка отвязана" : p.create ? "Сделка создана в Битриксе" : "Сделка привязана");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не получилось")),
  });
  const links = order.bitrix_deals ?? [];
  const whole = links.some((l) => !l.direction);
  // виды строк заказа без своей сделки
  const kinds = [...new Set(order.lines.map((l) => l.direction).filter((d): d is string => !!d))];
  const missing = whole ? [] : kinds.filter((k) => !links.some((l) => l.direction === k));
  const linkedIds = new Set(links.map((l) => l.deal_id));
  const dirOptions = [
    { value: "auto", label: "вид — по названию сделки" },
    { value: WHOLE, label: "на весь заказ" },
    ...kinds.map((k) => ({ value: k, label: DIRECTIONS[k] ?? k })),
  ];
  const dirParam = dir === undefined ? undefined : dir;
  return (
    <Card size="small" title={`Сделки в Битрикс24${links.length ? ` — ${links.length}` : ""}`}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        {links.length > 0 && (
          <Table
            size="small"
            pagination={false}
            rowKey="deal_id"
            dataSource={links}
            columns={[
              {
                title: "Сделка",
                render: (_, l) => (
                  <a href={l.url ?? undefined} target="_blank" rel="noreferrer">
                    №{l.deal_id}
                    {l.title ? ` · ${l.title}` : ""}
                  </a>
                ),
              },
              { title: "Ведёт строки", render: (_, l) => <Tag color={l.direction ? "blue" : "default"}>{l.direction_label}</Tag> },
              { title: "Стадия по строкам", render: (_, l) => l.stage },
              ...(canEdit
                ? [
                    {
                      title: "",
                      width: 100,
                      render: (_: unknown, l: (typeof links)[number]) => (
                        <Popconfirm title="Отвязать сделку от заказа? В Битриксе она останется." onConfirm={() => set.mutate({ unlink: true, deal: String(l.deal_id) })}>
                          <Button size="small">Отвязать</Button>
                        </Popconfirm>
                      ),
                    },
                  ]
                : []),
            ]}
          />
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {links.length
            ? "Стадии и даты сделок программа обновляет сама — каждую по готовности её строк."
            : `Не привязаны${order.status === "draft" ? " — при отправке производству найдутся по номеру счёта (по виду в названии: «пог.», «щиты», «царга») или создадутся" : ""}.`}
          {missing.length > 0 && links.length > 0 && ` Без сделки: ${missing.map((k) => DIRECTIONS[k] ?? k).join(", ")}.`}
        </Typography.Text>
        {canEdit && (
          <Space wrap>
            <Button size="small" onClick={() => setPick(true)}>
              Найти по счёту…
            </Button>
            {!links.length && (
              <Popconfirm title="Создать одну сделку на весь заказ?" onConfirm={() => set.mutate({ create: true, direction: WHOLE })}>
                <Button size="small">Создать сделку на заказ</Button>
              </Popconfirm>
            )}
            {missing.map((k) => (
              <Popconfirm key={k} title={`Создать сделку «${DIRECTIONS[k] ?? k}» по строкам этого вида?`} onConfirm={() => set.mutate({ create: true, direction: k })}>
                <Button size="small" loading={set.isPending && set.variables?.create && set.variables?.direction === k}>
                  Создать сделку: {(DIRECTIONS[k] ?? k).toLowerCase()}
                </Button>
              </Popconfirm>
            ))}
          </Space>
        )}
      </Space>
      <Modal open={pick} title={`Сделки по счёту ${order.invoice_no}`} footer={null} onCancel={() => setPick(false)} destroyOnHidden width={720}>
        <Space style={{ marginBottom: 8 }} wrap>
          <Typography.Text>Привязать как:</Typography.Text>
          <Select style={{ width: 260 }} value={dir === undefined ? "auto" : dir} onChange={(v) => setDir(v === "auto" ? undefined : v)} options={dirOptions} />
        </Space>
        {found.isError ? (
          <Typography.Text type="danger">{apiErrorMessage(found.error, "Не удалось найти")}</Typography.Text>
        ) : !found.isLoading && !(found.data ?? []).length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Сделок с этим номером счёта в названии нет" />
        ) : (
          <List
            loading={found.isLoading}
            dataSource={found.data ?? []}
            renderItem={(d) => (
              <List.Item
                actions={[
                  linkedIds.has(d.id) ? (
                    <Tag key="l" color="green">
                      привязана
                    </Tag>
                  ) : (
                    <Button key="l" type="primary" size="small" onClick={() => set.mutate({ deal: String(d.id), direction: dirParam })}>
                      Привязать
                    </Button>
                  ),
                ]}
              >
                <List.Item.Meta
                  title={
                    <a href={d.url ?? undefined} target="_blank" rel="noreferrer">
                      №{d.id} · {d.title}
                    </a>
                  }
                  description={`${d.created ?? ""}${d.amount ? ` · ${d.amount.toLocaleString("ru-RU")} ₽` : ""} · стадия ${d.stage}`}
                />
              </List.Item>
            )}
          />
        )}
        <Space.Compact style={{ width: "100%", marginTop: 12 }}>
          <Input placeholder="Или номер сделки / ссылка на неё" value={manual} onChange={(e) => setManual(e.target.value)} />
          <Button disabled={!manual.trim()} loading={set.isPending} onClick={() => set.mutate({ deal: manual.trim(), direction: dirParam })}>
            Привязать
          </Button>
        </Space.Compact>
      </Modal>
    </Card>
  );
}
