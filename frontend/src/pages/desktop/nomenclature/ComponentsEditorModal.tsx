import { useState } from "react";
import { isAxiosError } from "axios";
import { Button, InputNumber, Modal, Select, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listItems, setItemComponents, type TechCard } from "../../../api/items";

type Row = { component_item_id: number | null; qty_per_unit: number | null; stage_id: number | null };

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** Ручной состав позиции (единая модель, пункт 3): компонент, сколько на
 * 1 шт и на какой операции расходуется. Строки из BOM модели здесь не
 * правятся — они держатся по BOM на экране моделей. */
export default function ComponentsEditorModal({ card, onClose }: { card: TechCard; onClose: () => void }) {
  const qc = useQueryClient();
  const itemsQuery = useQuery({ queryKey: ["items", false], queryFn: () => listItems({ include_inactive: false }) });
  const [rows, setRows] = useState<Row[]>(
    card.inputs
      .filter((i) => i.source === "manual" && i.component_item_id !== null)
      .map((i) => ({ component_item_id: i.component_item_id, qty_per_unit: i.qty_per_unit, stage_id: i.stage_id })),
  );
  const patch = (i: number, p: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const itemOptions = (itemsQuery.data ?? [])
    .filter((i) => i.id !== card.item_id && !i.is_model)
    .map((i) => ({ value: i.id, label: `${i.name} · ${i.kind_name}` }));
  const opOptions = card.operations.filter((o) => o.id !== null).map((o) => ({ value: o.id as number, label: `${o.sequence_order}. ${o.name}` }));
  const bomRows = card.inputs.filter((i) => i.source === "bom");

  const mutation = useMutation({
    mutationFn: () =>
      setItemComponents(
        card.item_id,
        rows.map((r) => ({ component_item_id: r.component_item_id as number, qty_per_unit: r.qty_per_unit as number, stage_id: r.stage_id })),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["techcard"] });
      message.success("Состав сохранён");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить состав")),
  });
  const invalid = rows.some((r) => !r.component_item_id || !r.qty_per_unit || r.qty_per_unit <= 0);

  return (
    <Modal
      open
      width={860}
      title={`Состав — ${card.name}`}
      okText="Сохранить"
      cancelText="Отмена"
      onCancel={onClose}
      okButtonProps={{ disabled: invalid, loading: mutation.isPending }}
      onOk={() => mutation.mutate()}
    >
      <Typography.Paragraph type="secondary">
        Из чего состоит позиция: компонент, сколько на 1 шт и на какой операции маршрута расходуется.
        {bomRows.length > 0 && " Строки из BOM модели правятся на экране моделей изделий — здесь их нет."}
      </Typography.Paragraph>
      <Space direction="vertical" style={{ width: "100%" }}>
        {rows.map((r, i) => (
          <Space key={i} wrap>
            <Select
              showSearch
              optionFilterProp="label"
              placeholder="Компонент"
              style={{ width: 380 }}
              loading={itemsQuery.isLoading}
              value={r.component_item_id ?? undefined}
              options={itemOptions}
              onChange={(v) => patch(i, { component_item_id: v })}
            />
            <InputNumber
              min={0.0001}
              placeholder="на 1 шт"
              style={{ width: 110 }}
              value={r.qty_per_unit}
              onChange={(v) => patch(i, { qty_per_unit: v })}
            />
            <Select
              allowClear
              placeholder={opOptions.length ? "Операция расхода" : "Маршрут не задан"}
              disabled={opOptions.length === 0}
              style={{ width: 220 }}
              value={r.stage_id ?? undefined}
              options={opOptions}
              onChange={(v) => patch(i, { stage_id: v ?? null })}
            />
            <Button size="small" danger onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
              Убрать
            </Button>
          </Space>
        ))}
        <Button block onClick={() => setRows((rs) => [...rs, { component_item_id: null, qty_per_unit: 1, stage_id: null }])}>
          + компонент
        </Button>
      </Space>
    </Modal>
  );
}
