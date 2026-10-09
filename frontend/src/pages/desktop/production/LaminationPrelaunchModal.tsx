import { useEffect, useMemo, useState } from "react";
import { Alert, Button, InputNumber, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listAreas } from "../../../api/areas";
import { getOrderLamination, releaseOrderLamination, type LamRow, type ProductionOrder } from "../../../api/productionOrders";
import { apiErrorMessage } from "../../../utils/apiError";

interface Pick {
  qty: number | null;
  area: string | null;
}

/** Окутка панелей отдельно (09.10): задания на ламинацию панелей заказа до
 * запуска всего заказа — широкоформатная окутка на Фабрике или прессы.
 * Заказ остаётся черновиком; при его запуске эта окутка не повторяется. */
export default function LaminationPrelaunchModal({ order, onClose }: { order: ProductionOrder; onClose: () => void }) {
  const qc = useQueryClient();
  const rowsQuery = useQuery({ queryKey: ["order-lamination", order.id], queryFn: () => getOrderLamination(order.id) });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaName = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "—");
  const rows = useMemo(() => rowsQuery.data ?? [], [rowsQuery.data]);
  const [picks, setPicks] = useState<Record<number, Pick>>({});

  // По умолчанию — всё, что ещё не запущено, на окутку (Фабрика).
  useEffect(() => {
    setPicks(
      Object.fromEntries(
        rows.map((r) => [r.part_id, { qty: Math.max(0, r.quantity - r.launched) || null, area: r.factory_area ?? r.press_area }]),
      ),
    );
  }, [rows]);

  const pickOf = (r: LamRow): Pick => picks[r.part_id] ?? { qty: null, area: null };
  const patch = (r: LamRow, p: Partial<Pick>) => setPicks((prev) => ({ ...prev, [r.part_id]: { ...pickOf(r), ...p } }));
  const setAll = (fn: (r: LamRow) => string | null) =>
    setPicks((prev) => Object.fromEntries(rows.map((r) => [r.part_id, { ...(prev[r.part_id] ?? { qty: null }), area: fn(r) }])));

  const chosen = rows.filter((r) => (pickOf(r).qty ?? 0) > 0 && pickOf(r).area);
  const byArea = chosen.reduce<Record<string, number>>((acc, r) => {
    const a = pickOf(r).area!;
    acc[a] = (acc[a] ?? 0) + (pickOf(r).qty ?? 0);
    return acc;
  }, {});
  const factory = rows.find((r) => r.factory_area)?.factory_area ?? null;
  const press = rows.find((r) => r.press_area)?.press_area ?? null;

  const mutation = useMutation({
    mutationFn: () =>
      releaseOrderLamination(
        order.id,
        chosen.map((r) => ({ part_id: r.part_id, quantity: pickOf(r).qty!, area: pickOf(r).area! })),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-order"] });
      qc.invalidateQueries({ queryKey: ["production-orders"] });
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["order-lamination"] });
      message.success("Задания на окутку панелей созданы");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать задания")),
  });

  return (
    <Modal
      open
      width={1100}
      title={`Окутка панелей отдельно — заказ №${order.id} «${order.name}»`}
      onCancel={onClose}
      okText={`Создать задания (${chosen.length} панелей)`}
      cancelText="Отмена"
      okButtonProps={{ disabled: chosen.length === 0, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message="Создаются только задания на окутку/ламинацию панелей. Заказ остаётся черновиком: остальные участки запустите позже обычным запуском — окутка в нём не повторится."
        />
        <Space wrap>
          {factory && <Button size="small" onClick={() => setAll((r) => r.factory_area ?? r.press_area)}>Всё на {areaName(factory)}</Button>}
          {press && <Button size="small" onClick={() => setAll((r) => r.press_area)}>Всё на {areaName(press)}</Button>}
          {factory && (
            <Button
              size="small"
              onClick={() =>
                setAll((r) =>
                  r.factory_area && r.factory_min_pieces && (pickOf(r).qty ?? 0) >= r.factory_min_pieces ? r.factory_area : r.press_area,
                )
              }
            >
              По размеру партии
            </Button>
          )}
          {Object.entries(byArea).map(([a, n]) => (
            <Tag key={a}>
              {areaName(a)}: {n} шт
            </Tag>
          ))}
        </Space>
        <Table<LamRow>
          size="small"
          rowKey="part_id"
          loading={rowsQuery.isLoading}
          pagination={false}
          scroll={{ y: 480, x: 900 }}
          dataSource={rows}
          locale={{ emptyText: "В заказе нет панелей с окуткой или ламинацией" }}
          columns={[
            { title: "Панель", dataIndex: "part_name" },
            {
              title: "Плёнка",
              width: 190,
              render: (_, r) => r.film ?? <Typography.Text type="warning">не определена — выберут в задании</Typography.Text>,
            },
            { title: "Нужно, шт", dataIndex: "quantity", width: 90, align: "right" },
            {
              title: "Уже запущено",
              width: 100,
              align: "right",
              render: (_, r) => (r.launched ? <Tag color="blue">{r.launched}</Tag> : "—"),
            },
            {
              title: "Запустить, шт",
              width: 110,
              render: (_, r) => (
                <InputNumber size="small" min={0} style={{ width: 90 }} value={pickOf(r).qty} onChange={(v) => patch(r, { qty: v })} />
              ),
            },
            {
              title: "Участок",
              width: 250,
              render: (_, r) => (
                <Select
                  size="small"
                  style={{ width: 235 }}
                  value={pickOf(r).area ?? undefined}
                  onChange={(v) => patch(r, { area: v })}
                  options={[r.press_area, r.factory_area]
                    .filter((a): a is string => !!a)
                    .map((a) => ({ value: a, label: areaName(a) }))}
                />
              ),
            },
            {
              title: "Штрипс, мм",
              width: 100,
              align: "right",
              render: (_, r) => {
                const a = pickOf(r).area;
                if (!a) return "—";
                const w = r.strip_mm[a];
                return w == null ? <Typography.Text type="secondary">рулон</Typography.Text> : w;
              },
            },
          ]}
        />
      </Space>
    </Modal>
  );
}
