import { useEffect, useMemo, useState } from "react";
import { isAxiosError } from "axios";
import { useNavigate } from "react-router-dom";
import { Button, Card, Checkbox, Form, InputNumber, Modal, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { useAuth } from "../../../auth/AuthContext";
import { listAreas } from "../../../api/areas";
import { updatePart } from "../../../api/dictionaries";
import { createPfTasks, listPfDemand, type PfDemandRow } from "../../../api/pfDemand";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

const fmt = (n: number) => Math.round(n * 100) / 100;

/** Потребность п/ф — сколько деталей надо произвести, чтобы закрыть открытые
 * задания цеха и держать минимальный остаток; предложение округляется вверх
 * до минимальной партии. «Создать задания» отправляет их участку первого
 * этапа каждой детали (Задания участков). */
export default function PfDemand() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  const [onlyShortage, setOnlyShortage] = useState(true);
  const [qty, setQty] = useState<Record<number, number | null>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [editTarget, setEditTarget] = useState<PfDemandRow | null>(null);

  const demandQuery = useQuery({ queryKey: ["pf-demand"], queryFn: listPfDemand });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaName = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : null);

  const rows = useMemo(
    () => (demandQuery.data ?? []).filter((r) => !onlyShortage || r.shortage > 0),
    [demandQuery.data, onlyShortage],
  );

  useEffect(() => {
    const data = demandQuery.data ?? [];
    setQty(Object.fromEntries(data.map((r) => [r.part_id, r.suggested || null])));
    setSelected(data.filter((r) => r.suggested > 0 && r.first_stage_area).map((r) => r.part_id));
  }, [demandQuery.data]);

  const createMutation = useMutation({
    mutationFn: () =>
      createPfTasks({
        items: selected
          .filter((id) => (qty[id] ?? 0) > 0)
          .map((id) => ({ part_id: id, quantity_pieces: qty[id] as number })),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["pf-demand"] });
      qc.invalidateQueries({ queryKey: ["area-tasks"] });
      message.success(
        <span>
          Создано заданий участкам: {res.task_ids.length}. <a onClick={() => navigate("/area-tasks")}>Открыть задания участков</a>
        </span>,
      );
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать задания")),
  });

  const toCreate = selected.filter((id) => (qty[id] ?? 0) > 0);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Потребность п/ф"
        extra={
          canManage && (
            <Button
              type="primary"
              disabled={toCreate.length === 0}
              loading={createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              Создать задания ({toCreate.length})
            </Button>
          )
        }
      >
        <Typography.Paragraph type="secondary">
          Нужно = остаток плана по открытым заданиям цеха + минимальный остаток. Есть = все живые партии детали + уже
          заказанное в заданиях участкам. К производству — нехватка, но не меньше минимальной партии. Задание уходит
          участку первого этапа детали.
        </Typography.Paragraph>
        <Checkbox checked={onlyShortage} onChange={(e) => setOnlyShortage(e.target.checked)}>
          Только с нехваткой
        </Checkbox>
      </Card>

      <ResponsiveTable<PfDemandRow>
        tableKey="pf-demand"
        lockedColumns={["Деталь"]}
        size="small"
        rowKey="part_id"
        loading={demandQuery.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: onlyShortage ? "Нехватки нет" : "Нет деталей с минимальным остатком или потребностью" }}
        rowSelection={
          canManage
            ? {
                selectedRowKeys: selected,
                onChange: (keys) => setSelected(keys as number[]),
                getCheckboxProps: (r) => ({ disabled: !r.first_stage_area }),
              }
            : undefined
        }
        columns={[
          { title: "Деталь", dataIndex: "part_name" },
          {
            title: "Мин. остаток / партия",
            render: (_, r) => (
              <Space size={4}>
                <span>
                  {r.min_stock != null ? fmt(r.min_stock) : "—"} / {r.min_batch != null ? fmt(r.min_batch) : "—"}
                </span>
                {canManage && (
                  <Button size="small" type="link" onClick={() => setEditTarget(r)}>
                    изменить
                  </Button>
                )}
              </Space>
            ),
          },
          { title: "По заданиям цеха", render: (_, r) => fmt(r.task_demand) },
          { title: "Нужно", render: (_, r) => fmt(r.need) },
          { title: "Есть", render: (_, r) => fmt(r.stock) },
          { title: "В работе", render: (_, r) => fmt(r.in_work) },
          {
            title: "Не хватает",
            render: (_, r) => (r.shortage > 0 ? <Tag color="red">{fmt(r.shortage)}</Tag> : <Tag color="green">хватает</Tag>),
          },
          {
            title: "К производству, шт",
            render: (_, r) => (
              <InputNumber
                min={0}
                size="small"
                style={{ width: 100 }}
                disabled={!canManage}
                value={qty[r.part_id] ?? null}
                onChange={(v) => setQty((prev) => ({ ...prev, [r.part_id]: v }))}
              />
            ),
          },
          {
            title: "Участок первого этапа",
            render: (_, r) =>
              r.first_stage_area ? (
                <span>
                  {areaName(r.first_stage_area)} · <Typography.Text type="secondary">{r.first_stage_name}</Typography.Text>
                </span>
              ) : (
                <Tag color="orange">не указан</Tag>
              ),
          },
        ]}
      />

      {editTarget && <MinValuesModal row={editTarget} onClose={() => setEditTarget(null)} />}
    </Space>
  );
}

function MinValuesModal({ row, onClose }: { row: PfDemandRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ min_stock_pieces?: number | null; min_batch_pieces?: number | null }>();
  const mutation = useMutation({
    mutationFn: (v: { min_stock_pieces?: number | null; min_batch_pieces?: number | null }) =>
      updatePart(row.part_id, { min_stock_pieces: v.min_stock_pieces ?? null, min_batch_pieces: v.min_batch_pieces ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pf-demand"] });
      qc.invalidateQueries({ queryKey: ["parts"] });
      message.success("Сохранено");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  return (
    <Modal title={row.part_name} open onCancel={onClose} footer={null} destroyOnHidden>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ min_stock_pieces: row.min_stock ?? undefined, min_batch_pieces: row.min_batch ?? undefined }}
        onFinish={(v) => mutation.mutate(v)}
      >
        <Form.Item name="min_stock_pieces" label="Минимальный остаток, шт" extra="Пусто — не держать запас сверх заданий">
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="min_batch_pieces" label="Минимальная партия производства, шт" extra="Пусто — производить ровно нехватку">
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
          Сохранить
        </Button>
      </Form>
    </Modal>
  );
}
