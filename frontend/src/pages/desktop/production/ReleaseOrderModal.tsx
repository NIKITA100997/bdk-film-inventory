import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { isAxiosError } from "axios";
import { Alert, Button, Checkbox, InputNumber, Modal, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listAreas } from "../../../api/areas";
import {
  getReleasePreview,
  releaseProductionOrder,
  type PfNeed,
  type ProductionOrder,
} from "../../../api/productionOrders";
import LaminationAreaSelect from "../../../components/LaminationAreaSelect";
import type { PfDemandRow } from "../../../api/pfDemand";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

const keyOf = (n: PfNeed) => `${n.order_line_id}|${n.part_id}|${n.consumer_part_id ?? ""}`;

/** Запуск заказа: задания участкам по маршрутам + п/ф под заказ (щитовым
 * панели и каркасы делаются под заказ — по составу вглубь, на полное
 * количество; свободный остаток виден — можно уменьшить). Сроки операций
 * ставятся сами назад от отгрузки по рабочим дням. */
export default function ReleaseOrderModal({ order, onClose }: { order: ProductionOrder; onClose: () => void }) {
  const qc = useQueryClient();
  const previewQuery = useQuery({ queryKey: ["release-preview", order.id], queryFn: () => getReleasePreview(order.id) });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaName = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : null);
  const needs = useMemo(() => previewQuery.data ?? [], [previewQuery.data]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, number | null>>({});
  const [stock, setStock] = useState<Record<string, number | null>>({});
  const [lam, setLam] = useState<Record<string, string>>({});

  useEffect(() => {
    setPicked(Object.fromEntries(needs.map((n) => [keyOf(n), true])));
    setQty(Object.fromEntries(needs.map((n) => [keyOf(n), n.launch ?? n.quantity])));
    setStock(Object.fromEntries(needs.map((n) => [keyOf(n), n.from_stock ?? 0])));
  }, [needs]);

  const lineName = (id: number) => order.lines.find((l) => l.id === id)?.item_name ?? "";
  const lamRow = (n: PfNeed) =>
    ({ lamination_area: n.lamination_area, factory_area: n.factory_area, factory_min_pieces: n.factory_min_pieces }) as PfDemandRow;
  // Площадку ламинации выбирают вручную (01.10): правило «окутка на
  // Фабрике или прессы» ещё не задано — автоматический порог отключён.
  const lamValue = (n: PfNeed) => lam[keyOf(n)];
  const lamRows = needs.filter((n) => n.lamination_area && picked[keyOf(n)] && (qty[keyOf(n)] ?? 0) > 0);
  const unassigned = lamRows.filter((n) => !lam[keyOf(n)]);
  const panelsBy = (code: string | undefined) =>
    lamRows.filter((n) => lam[keyOf(n)] === code).reduce((s, n) => s + (qty[keyOf(n)] ?? 0), 0);
  const setAllLam = (pick: (n: PfNeed) => string | null | undefined) =>
    setLam((p) => {
      const next = { ...p };
      for (const n of lamRows) {
        const v = pick(n);
        if (v) next[keyOf(n)] = v;
      }
      return next;
    });
  const factoryCode = needs.find((n) => n.factory_area)?.factory_area ?? null;
  const pressCode = needs.find((n) => n.lamination_area)?.lamination_area ?? null;

  const mutation = useMutation({
    mutationFn: () =>
      releaseProductionOrder(
        order.id,
        needs
          .filter((n) => picked[keyOf(n)] && ((qty[keyOf(n)] ?? 0) > 0 || (stock[keyOf(n)] ?? 0) > 0))
          .map((n) => ({
            order_line_id: n.order_line_id,
            part_id: n.part_id,
            quantity: qty[keyOf(n)] ?? 0,
            from_stock: stock[keyOf(n)] ?? 0,
            consumer_part_id: n.consumer_part_id,
            lamination_area: n.lamination_area ? lamValue(n) ?? null : null,
          })),
      ),
    onSuccess: (o) => {
      for (const k of [["production-orders"], ["production-tasks"], ["pf-demand"], ["plan-board"]]) qc.invalidateQueries({ queryKey: k });
      message.success(
        o.plan_late
          ? `Заказ запущен, но к отгрузке не успевает: готово ${dayjs(o.plan_finish).format("DD.MM")}`
          : `Заказ запущен: заданий ${o.task_ids.length}${o.plan_finish ? `, готово к ${dayjs(o.plan_finish).format("DD.MM")}` : ""}`,
      );
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось запустить заказ")),
  });

  const count = needs.filter((n) => picked[keyOf(n)] && (qty[keyOf(n)] ?? 0) > 0).length;
  const fromStockTotal = needs.filter((n) => picked[keyOf(n)] && (stock[keyOf(n)] ?? 0) > 0).length;
  return (
    <Modal
      open
      width="95vw"
      style={{ maxWidth: 1100, top: 24 }}
      title={`Запуск заказа №${order.id} «${order.name}»`}
      okText={count || fromStockTotal ? `Запустить (п/ф в работу: ${count}, со склада: ${fromStockTotal})` : "Запустить"}
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ loading: mutation.isPending, disabled: unassigned.length > 0 }}
      onOk={() => mutation.mutate()}
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Text type="secondary">
          Появятся задания участкам по маршрутам позиций. Сроки операций — назад от{" "}
          {order.ship_date ? `отгрузки ${dayjs(order.ship_date).format("DD.MM.YYYY")}` : "сегодняшнего дня (отгрузка не указана)"} по
          рабочим дням (пн–пт); поправить — в «Планировщике».
        </Typography.Text>
        {needs.length > 0 ? (
          <>
            <Alert
              type="info"
              showIcon
              message="П/ф для заказа"
              description="«Со склада» — свободный остаток сразу уходит в резерв этого заказа (другие задания его не возьмут). «Запустить» — задания на п/ф, сделанное тоже уйдёт в резерв. Детали «на склад» по умолчанию берутся со склада, «под заказ» (щиты, панели, детали в плёнке) — запускаются; числа можно поправить. Вложенные п/ф посчитаны от того, что запускается."
            />
            {lamRows.length > 0 && (
              <Alert
                type={unassigned.length ? "warning" : "success"}
                showIcon
                message={
                  unassigned.length
                    ? `Ламинация панелей: выберите площадку — не распределено строк ${unassigned.length} (${unassigned.reduce((s, n) => s + (qty[keyOf(n)] ?? 0), 0)} шт)`
                    : "Ламинация панелей распределена"
                }
                description={
                  <Space wrap>
                    {factoryCode && (
                      <Button size="small" onClick={() => setAllLam((n) => n.factory_area)}>
                        Всё на окутку ({areaName(factoryCode)})
                      </Button>
                    )}
                    {pressCode && (
                      <Button size="small" onClick={() => setAllLam((n) => n.lamination_area)}>
                        Всё на {areaName(pressCode)}
                      </Button>
                    )}
                    {factoryCode && <Typography.Text type="secondary">{areaName(factoryCode)}: {panelsBy(factoryCode)} шт</Typography.Text>}
                    {pressCode && <Typography.Text type="secondary">{areaName(pressCode)}: {panelsBy(pressCode)} шт</Typography.Text>}
                  </Space>
                }
              />
            )}
            <Table<PfNeed>
              size="small"
              rowKey={keyOf}
              pagination={false}
              loading={previewQuery.isLoading}
              dataSource={needs}
              scroll={{ x: "max-content" }}
              columns={[
                {
                  title: "",
                  width: 40,
                  render: (_, n) => (
                    <Checkbox
                      checked={!!picked[keyOf(n)]}
                      onChange={(e) => setPicked((p) => ({ ...p, [keyOf(n)]: e.target.checked }))}
                    />
                  ),
                },
                {
                  title: "П/ф",
                  render: (_, n) => (
                    <Space direction="vertical" size={0} style={{ paddingLeft: n.depth * 18 }}>
                      <span>
                        {n.part_name}{" "}
                        {n.mode && <Tag color={n.mode === "stock" ? "green" : "orange"}>{n.mode === "stock" ? "на склад" : "под заказ"}</Tag>}
                      </span>
                      {n.depth === 0 && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          для: {lineName(n.order_line_id)}
                        </Typography.Text>
                      )}
                    </Space>
                  ),
                },
                { title: "Нужно, шт", render: (_, n) => n.quantity },
                {
                  title: "Свободно",
                  render: (_, n) => (n.free_stock > 0 ? <b>{n.free_stock}</b> : <Typography.Text type="secondary">0</Typography.Text>),
                },
                {
                  title: "Со склада, шт",
                  render: (_, n) =>
                    n.free_stock > 0 ? (
                      <InputNumber
                        size="small"
                        min={0}
                        max={Math.min(n.free_stock, n.quantity)}
                        style={{ width: 90 }}
                        disabled={!picked[keyOf(n)]}
                        value={stock[keyOf(n)] ?? null}
                        onChange={(v) => {
                          const take = v ?? 0;
                          setStock((p) => ({ ...p, [keyOf(n)]: take }));
                          setQty((p) => ({ ...p, [keyOf(n)]: Math.max(0, Math.round((n.quantity - take) * 100) / 100) }));
                        }}
                      />
                    ) : (
                      <Typography.Text type="secondary">—</Typography.Text>
                    ),
                },
                {
                  title: "Запустить, шт",
                  render: (_, n) => (
                    <InputNumber
                      size="small"
                      min={0}
                      style={{ width: 100 }}
                      disabled={!picked[keyOf(n)]}
                      value={qty[keyOf(n)] ?? null}
                      onChange={(v) => setQty((p) => ({ ...p, [keyOf(n)]: v }))}
                    />
                  ),
                },
                {
                  title: "Ламинация",
                  render: (_, n) => (
                    <LaminationAreaSelect
                      row={lamRow(n)}
                      value={lamValue(n)}
                      areaName={areaName}
                      disabled={!picked[keyOf(n)]}
                      onChange={(v) => setLam((p) => ({ ...p, [keyOf(n)]: v }))}
                    />
                  ),
                },
              ]}
            />
          </>
        ) : (
          !previewQuery.isLoading && <Typography.Text type="secondary">П/ф по составу позиций не нужны.</Typography.Text>
        )}
      </Space>
    </Modal>
  );
}
