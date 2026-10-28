import { useMemo, useState } from "react";
import { Alert, Button, Input, Segmented, Space, Table, Tag, Typography, message } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { getBitrixFunnel, linkAllBitrixDeals, linkBitrixDeal, type FunnelDeal } from "../../../api/customerOrders";
import { apiErrorMessage } from "../../../utils/apiError";
import { useAuth } from "../../../auth/AuthContext";
import { hasPerm } from "../../../auth/permissions";
import ScheduleImportModal from "../production/ScheduleImportModal";

type View = "none" | "match" | "linked" | "orphans";
const money = (v: number | null) => (v == null ? "" : `${Math.round(v).toLocaleString("ru-RU")} ₽`);

/** Сделки Битрикс24 (19.10): все сделки воронки против заказов клиентов —
 * что продано, но не заведено; что можно привязать; что уже связано; и
 * заказы без сделки. Сопоставление — по номеру счёта в начале названия. */
export default function BitrixDeals() {
  const { user } = useAuth();
  const canEdit = hasPerm(user, "production_tasks.manage", "orders.request");
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [view, setView] = useState<View>("none");
  const [q, setQ] = useState("");
  const [fromDeal, setFromDeal] = useState<FunnelDeal | null>(null);
  const funnel = useQuery({ queryKey: ["bitrix-funnel"], queryFn: () => getBitrixFunnel(false), staleTime: 60_000, retry: false });
  const refresh = useMutation({
    mutationFn: () => getBitrixFunnel(true),
    onSuccess: (d) => qc.setQueryData(["bitrix-funnel"], d),
    onError: (e) => message.error(apiErrorMessage(e, "Битрикс24 не ответил")),
  });
  const linkAll = useMutation({
    mutationFn: linkAllBitrixDeals,
    onSuccess: (r) => {
      message.success(r.linked ? `Привязано сделок: ${r.linked}` : "Однозначных пар не нашлось");
      qc.invalidateQueries({ queryKey: ["bitrix-funnel"] });
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сопоставить")),
  });
  const link = useMutation({
    mutationFn: ({ orderId, dealId }: { orderId: number; dealId: number }) => linkBitrixDeal(orderId, dealId),
    onSuccess: () => {
      message.success("Сделка привязана к заказу");
      qc.invalidateQueries({ queryKey: ["bitrix-funnel"] });
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось привязать")),
  });

  const data = funnel.data;
  const deals = data?.deals ?? [];
  const counts = {
    none: deals.filter((d) => d.state === "none" && !d.closed).length,
    match: deals.filter((d) => d.state === "match" || d.state === "many").length,
    linked: deals.filter((d) => d.state === "linked").length,
    orphans: data?.orders_without_deal.length ?? 0,
  };
  const rows = useMemo(() => {
    const t = q.trim().toLowerCase();
    const list =
      view === "none"
        ? deals.filter((d) => d.state === "none" && !d.closed)
        : view === "match"
          ? deals.filter((d) => d.state === "match" || d.state === "many")
          : deals.filter((d) => d.state === "linked");
    return t ? list.filter((d) => `${d.title} ${d.company ?? ""} ${d.assigned ?? ""}`.toLowerCase().includes(t)) : list;
  }, [deals, view, q]);

  if (funnel.isError)
    return <Alert type="warning" showIcon message="Сделки не загрузились" description={apiErrorMessage(funnel.error, "Битрикс24 не ответил")} />;

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Все сделки воронки Битрикс24 против заказов клиентов: сделка и заказ сопоставляются по номеру счёта в начале
        названия сделки. «Нет заказа» — продано, но в программе не заведено.
        {data && ` Загружено ${dayjs(data.loaded_at * 1000).format("DD.MM HH:mm")}.`}
      </Typography.Paragraph>
      {data && !data.sync_enabled && (
        <Alert
          type="info"
          showIcon
          message="Синхронизация сделок выключена"
          description={`Сначала сопоставьте текущие сделки с заказами. После включения («Настройки → Битрикс24») стадии сделок пойдут за заказами${data.auto_create ? ", а для заказов без сделки программа будет создавать сделку сама" : ""}.`}
        />
      )}
      <Space wrap>
        <Segmented
          value={view}
          onChange={(v) => setView(v as View)}
          options={[
            { value: "none", label: `Нет заказа · ${counts.none}` },
            { value: "match", label: `Можно привязать · ${counts.match}` },
            { value: "linked", label: `Есть заказ · ${counts.linked}` },
            { value: "orphans", label: `Заказ без сделки · ${counts.orphans}` },
          ]}
        />
        <Input.Search allowClear placeholder="Счёт, клиент, ответственный" style={{ width: 260 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button icon={<ReloadOutlined />} loading={refresh.isPending || funnel.isFetching} onClick={() => refresh.mutate()}>
          Обновить из Битрикса
        </Button>
        {canEdit && counts.match > 0 && (
          <Button type="primary" loading={linkAll.isPending} onClick={() => linkAll.mutate()}>
            Привязать однозначные
          </Button>
        )}
      </Space>

      {view === "orphans" ? (
        <Table
          size="small"
          rowKey="id"
          loading={funnel.isLoading}
          pagination={{ pageSize: 50, hideOnSinglePage: true }}
          dataSource={data?.orders_without_deal ?? []}
          locale={{ emptyText: "У всех заказов есть сделка" }}
          columns={[
            { title: "Счёт", render: (_, o) => <Link to={`/customer-orders/${o.id}`}>{o.invoice}</Link> },
            { title: "Клиент", dataIndex: "customer" },
            { title: "Стадия", dataIndex: "stage" },
            {
              title: "",
              render: () => (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  сделки с этим номером счёта в воронке нет — создайте в Битриксе или в карточке заказа
                </Typography.Text>
              ),
            },
          ]}
        />
      ) : (
        <Table<FunnelDeal>
          size="small"
          rowKey="id"
          loading={funnel.isLoading}
          pagination={{ pageSize: 50, hideOnSinglePage: true }}
          dataSource={rows}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: funnel.isLoading ? "Загружаю сделки из Битрикса…" : "Нет таких сделок" }}
          columns={[
            {
              title: "Сделка",
              render: (_, d) => (
                <div style={{ whiteSpace: "normal", maxWidth: 360 }}>
                  {d.url ? (
                    <a href={d.url} target="_blank" rel="noreferrer">
                      {d.title}
                    </a>
                  ) : (
                    d.title
                  )}
                  <div style={{ fontSize: 12, color: "#6B6B68" }}>
                    №{d.id}
                    {d.created ? ` · ${dayjs(d.created).format("DD.MM.YYYY")}` : ""}
                  </div>
                </div>
              ),
            },
            { title: "Счёт", render: (_, d) => d.invoice ?? <Typography.Text type="secondary">—</Typography.Text> },
            { title: "Вид", render: (_, d) => (d.kind ? <Tag>{d.kind}</Tag> : "") },
            { title: "Шт", align: "right", render: (_, d) => d.qty ?? "" },
            { title: "Сумма", align: "right", render: (_, d) => money(d.amount) },
            { title: "Клиент", render: (_, d) => <div style={{ whiteSpace: "normal", maxWidth: 220 }}>{d.company ?? ""}</div> },
            { title: "Ответственный", dataIndex: "assigned" },
            { title: "Стадия", render: (_, d) => <Tag color={d.closed ? "default" : "blue"}>{d.stage_name}</Tag> },
            {
              title: "Заказ",
              render: (_, d) =>
                d.state === "linked" ? (
                  <Space direction="vertical" size={0}>
                    <Link to={`/customer-orders/${d.order_id}`}>{d.order_invoice}</Link>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {d.order_stage}
                    </Typography.Text>
                  </Space>
                ) : d.candidates.length > 0 ? (
                  <Space direction="vertical" size={4}>
                    {d.candidates.map((c) => (
                      <Space key={c.id} size={6}>
                        <Link to={`/customer-orders/${c.id}`}>{c.invoice}</Link>
                        {canEdit && (
                          <Button size="small" loading={link.isPending} onClick={() => link.mutate({ orderId: c.id, dealId: d.id })}>
                            Привязать
                          </Button>
                        )}
                      </Space>
                    ))}
                  </Space>
                ) : canEdit ? (
                  <Button size="small" type="primary" ghost onClick={() => setFromDeal(d)}>
                    Завести заказ…
                  </Button>
                ) : null,
            },
          ]}
        />
      )}
      {fromDeal && (
        <ScheduleImportModal
          target="customer"
          fromDeal={{
            id: fromDeal.id, title: fromDeal.title, invoice: fromDeal.invoice, company: fromDeal.company,
            amount: fromDeal.amount, assignedBx: fromDeal.assigned_bx, created: fromDeal.created,
          }}
          onClose={() => setFromDeal(null)}
          onCustomerCreated={(ids) => {
            setFromDeal(null);
            qc.invalidateQueries({ queryKey: ["bitrix-funnel"] });
            if (ids.length === 1) navigate(`/customer-orders/${ids[0]}`);
          }}
        />
      )}
    </Space>
  );
}
