import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { isAxiosError } from "axios";
import { Alert, Checkbox, InputNumber, Modal, Space, Table, Typography, message } from "antd";
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
  const [lam, setLam] = useState<Record<string, string>>({});

  useEffect(() => {
    setPicked(Object.fromEntries(needs.map((n) => [keyOf(n), true])));
    setQty(Object.fromEntries(needs.map((n) => [keyOf(n), n.quantity])));
  }, [needs]);

  const lineName = (id: number) => order.lines.find((l) => l.id === id)?.item_name ?? "";
  const lamRow = (n: PfNeed) =>
    ({ lamination_area: n.lamination_area, factory_area: n.factory_area, factory_min_pieces: n.factory_min_pieces }) as PfDemandRow;
  const lamValue = (n: PfNeed) => {
    const q = qty[keyOf(n)] ?? 0;
    return lam[keyOf(n)] ?? (n.factory_area && n.factory_min_pieces && q >= n.factory_min_pieces ? n.factory_area : n.lamination_area ?? undefined);
  };

  const mutation = useMutation({
    mutationFn: () =>
      releaseProductionOrder(
        order.id,
        needs
          .filter((n) => picked[keyOf(n)] && (qty[keyOf(n)] ?? 0) > 0)
          .map((n) => ({
            order_line_id: n.order_line_id,
            part_id: n.part_id,
            quantity: qty[keyOf(n)] as number,
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
  return (
    <Modal
      open
      width="95vw"
      style={{ maxWidth: 1100, top: 24 }}
      title={`Запуск заказа №${order.id} «${order.name}»`}
      okText={count ? `Запустить + п/ф: ${count}` : "Запустить"}
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ loading: mutation.isPending }}
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
              message="П/ф под заказ"
              description="Панели и каркасы щитовых делаются под заказ — отмеченное запустится вместе с заказом, сделанное пойдёт в резерв его заданий. Есть свободный остаток — можно уменьшить количество."
            />
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
                      <span>{n.part_name}</span>
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
