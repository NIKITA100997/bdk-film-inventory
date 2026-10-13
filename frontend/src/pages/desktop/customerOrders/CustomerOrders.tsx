import { useMemo, useState } from "react";
import { Button, Card, Checkbox, Dropdown, Input, Modal, Progress, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import ResponsiveTable from "../../../components/ResponsiveTable";
import ScheduleImportModal from "../production/ScheduleImportModal";
import { STAGE_COLOR, launchCustomerOrders, listCustomerOrders, type CustomerOrder } from "../../../api/customerOrders";
import { PRIORITY_COLOR, PRIORITY_LABEL } from "../../../api/productionOrders";
import { apiErrorMessage } from "../../../utils/apiError";
import { CustomerOrderModal, fmt, fmtShort, useCustomerOrderRights } from "./parts";

type Filter = "all" | "wait" | "accepted" | "work" | "ready" | "mine";
const FILTERS: [Filter, string, (o: CustomerOrder) => boolean][] = [
  ["all", "Все", () => true],
  ["wait", "Ждут решения", (o) => o.status === "submitted"],
  ["accepted", "Принятые без запуска", (o) => o.status === "accepted" && o.launched < o.qty - 0.001],
  ["work", "В запуске и производстве", (o) => o.stage === "in_production" || o.stage === "assembled"],
  ["ready", "Готовы / отгружаются", (o) => o.stage === "ready" || o.stage === "shipped_part"],
  ["mine", "Черновики и возвращённые", (o) => o.status === "draft" || o.status === "returned"],
];

/** Можно собрать в запуск: принят, есть незапущенный остаток. */
const launchable = (o: CustomerOrder) => o.status === "accepted" && o.launched < o.qty - 0.001;

/** Заказы клиентов (13.10): заказ = счёт 1С. Менеджер заводит и отправляет
 * в производство; начальник производства принимает с датами и собирает
 * принятые заказы в запуск — заказ на производство. */
export default function CustomerOrders() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { production, canEdit } = useCustomerOrderRights();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [picked, setPicked] = useState<number[]>([]);
  const [launchName, setLaunchName] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["customer-orders", includeClosed], queryFn: () => listCustomerOrders(includeClosed) });
  const all = useMemo(() => query.data ?? [], [query.data]);
  const needle = q.trim().toLowerCase();
  const shown = all
    .filter(FILTERS.find((f) => f[0] === filter)![2])
    .filter(
      (o) =>
        !needle ||
        `${o.invoice_no} ${o.customer ?? ""} ${o.manager_name ?? ""} ${o.lines.map((l) => l.item_name).join(" ")}`.toLowerCase().includes(needle),
    );
  const pickedOrders = all.filter((o) => picked.includes(o.id));
  const launch = useMutation({
    mutationFn: () => launchCustomerOrders(picked, launchName?.trim() || null),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["customer-orders"] });
      qc.invalidateQueries({ queryKey: ["production-orders"] });
      message.success("Запуск собран — настройте п/ф и площадки и запустите");
      setLaunchName(null);
      setPicked([]);
      navigate(`/production-orders/${r.production_order_id}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось собрать запуск")),
  });

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card
        title="Заказы клиентов"
        extra={
          <Space wrap>
            <Checkbox checked={includeClosed} onChange={(e) => setIncludeClosed(e.target.checked)}>
              С отгруженными и отменёнными
            </Checkbox>
            {canEdit && (
              <Dropdown
                trigger={["click"]}
                menu={{
                  items: [
                    { key: "manual", label: "Вручную" },
                    { key: "import", label: "Из счёта 1С или графика…" },
                  ],
                  onClick: ({ key }) => (key === "manual" ? setCreating(true) : setImporting(true)),
                }}
              >
                <Button type="primary">Новый заказ клиента ▾</Button>
              </Dropdown>
            )}
          </Space>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Заказ клиента — это счёт 1С: клиент, позиции, вилка отгрузки. Менеджер отправляет его в производство; начальник
          производства принимает с датами готовности и отгрузки (или возвращает с комментарием) и собирает принятые заказы
          в запуск — заказ на производство. Стадия дальше считается сама: в производстве, готов, отгружен.
        </Typography.Paragraph>
      </Card>
      <Space wrap size={[6, 6]}>
        <Input.Search allowClear placeholder="Счёт, клиент, менеджер, позиция" style={{ width: 300 }} value={q} onChange={(e) => setQ(e.target.value)} />
        {FILTERS.map(([k, label, fn]) => (
          <Tag.CheckableTag key={k} checked={filter === k} onChange={() => setFilter(k)} style={{ fontSize: 13, padding: "3px 10px" }}>
            {label} {all.filter(fn).length}
          </Tag.CheckableTag>
        ))}
      </Space>
      {production && (
        <Space wrap>
          <Button type="primary" disabled={!pickedOrders.length} onClick={() => setLaunchName("")}>
            Собрать запуск из выбранных ({pickedOrders.length})
          </Button>
          <Typography.Text type="secondary">
            отметьте принятые заказы — их незапущенные позиции станут одним заказом на производство
          </Typography.Text>
        </Space>
      )}
      <ResponsiveTable<CustomerOrder>
        tableKey="customer-orders"
        lockedColumns={["Счёт"]}
        size="small"
        rowKey="id"
        loading={query.isLoading}
        dataSource={shown}
        pagination={{ pageSize: 30 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Заказов клиентов пока нет" }}
        rowSelection={
          production
            ? {
                selectedRowKeys: picked,
                onChange: (k) => setPicked(k as number[]),
                getCheckboxProps: (o) => ({ disabled: !launchable(o) }),
              }
            : undefined
        }
        onRow={(o) => ({ onClick: () => navigate(`/customer-orders/${o.id}`), style: { cursor: "pointer" } })}
        columns={[
          {
            title: "Счёт",
            render: (_, o) => (
              <Space direction="vertical" size={0}>
                <span>
                  <b>{o.invoice_no}</b>
                  {o.customer ? ` · ${o.customer}` : ""}{" "}
                  {o.priority > 0 && <Tag color={PRIORITY_COLOR[o.priority]}>{PRIORITY_LABEL[o.priority]}</Tag>}
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {o.lines.length} поз.: {o.lines.slice(0, 2).map((l) => l.item_name).join(", ")}
                  {o.lines.length > 2 ? " …" : ""}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: "Стадия",
            render: (_, o) => (
              <Space direction="vertical" size={2}>
                <Tag color={STAGE_COLOR[o.stage]} style={{ marginInlineEnd: 0 }}>
                  {o.stage_label}
                </Tag>
                {o.status === "accepted" && o.launched > 0 && o.launched < o.qty - 0.001 && (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    запущено {o.launched} из {o.qty}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: "Вилка / отгрузка",
            render: (_, o) => (
              <Space direction="vertical" size={0}>
                <span>{o.ship_date && o.status === "accepted" ? `отгрузка ${fmt(o.ship_date)}` : "—"}</span>
                {o.promised_ready && o.status === "accepted" && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    готовность {fmt(o.promised_ready)}
                  </Typography.Text>
                )}
                {(o.ship_from || o.ship_to) && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    вилка {fmtShort(o.ship_from)}–{fmtShort(o.ship_to)}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: "Готово / отгружено",
            render: (_, o) =>
              o.status !== "accepted" ? (
                <Typography.Text type="secondary">{o.qty} шт</Typography.Text>
              ) : (
                <Space size={8}>
                  <Progress
                    percent={o.qty ? Math.round((o.received / o.qty) * 100) : 0}
                    success={{ percent: o.qty ? Math.round((o.shipped / o.qty) * 100) : 0 }}
                    size="small"
                    style={{ width: 110 }}
                  />
                  <span style={{ whiteSpace: "nowrap" }}>
                    {o.received}/{o.qty}
                    {o.shipped ? `, отгр. ${o.shipped}` : ""}
                  </span>
                </Space>
              ),
          },
          { title: "Менеджер", render: (_, o) => o.manager_name ?? "—" },
          { title: "Создан", render: (_, o) => dayjs(o.created_at).format("DD.MM.YYYY") },
        ]}
      />
      {creating && (
        <CustomerOrderModal
          order={null}
          onClose={() => setCreating(false)}
          onSaved={(o) => {
            setCreating(false);
            navigate(`/customer-orders/${o.id}`);
          }}
        />
      )}
      {importing && (
        <ScheduleImportModal
          target="customer"
          onClose={() => setImporting(false)}
          onCustomerCreated={(ids) => {
            setImporting(false);
            if (ids.length === 1) navigate(`/customer-orders/${ids[0]}`);
            else setFilter("mine");
          }}
        />
      )}
      <Modal
        open={launchName !== null}
        title="Собрать запуск"
        okText="Собрать и открыть"
        cancelText="Отмена"
        onCancel={() => setLaunchName(null)}
        okButtonProps={{ loading: launch.isPending }}
        onOk={() => launch.mutate()}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Typography.Text>
            Заказов: {pickedOrders.length}, незапущенных штук:{" "}
            {pickedOrders.reduce((s, o) => s + Math.max(0, o.qty - o.launched), 0)}. Срок запуска — по самому раннему заказу,
            приоритет — по самому срочному.
          </Typography.Text>
          <Typography.Text type="secondary">{pickedOrders.map((o) => o.invoice_no).join(", ")}</Typography.Text>
          <Input
            placeholder={`Название (по умолчанию — «Запуск ${dayjs().format("DD.MM")}: счета…»)`}
            value={launchName ?? ""}
            onChange={(e) => setLaunchName(e.target.value)}
          />
          <Typography.Text type="secondary">
            Получится черновик заказа на производство: там выбираются п/ф со склада, площадки ламинации и сроки, затем «Запустить».
          </Typography.Text>
        </Space>
      </Modal>
    </Space>
  );
}
