import { useMemo, useState } from "react";
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Space, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { searchUnits, type MaterialSku, type MaterialUnit } from "../api/units";
import { getCalcSettings } from "../api/abc";
import ResponsiveTable from "./ResponsiveTable";
import type { CuttingFormInitialWidthCut } from "./CuttingForm";

interface QueueRowLike {
  line: { id: number; strip_width_mm?: number | null; width_mm: number; part_name?: string | null };
  task: { area: string };
}

interface CuttingBatchEntryLike {
  donorUnitId: number;
  donorWidthMm: number;
  donorLengthM: number;
  wasteMm: number;
  pieces: { widthMm: number; label: string }[];
}

interface PieceRow {
  id: string;
  enabled: boolean;
  width_mm: number;
  label: string;
  production_task_line_id?: number;
  area?: string;
  custom: boolean;
}

let rowSeq = 0;
const nextRowId = () => `manual-row-${++rowSeq}`;

/** Ручной подбор донора и раскроя для группового плана резки (раздел про
 * "не согласен с предложением программы") — автоподбор через
 * /units/cutting-plan (CuttingPlanGroupButton) даёт ровно ОДИН вариант:
 * какой донор и какие ширины из него резать. Здесь то же самое, но
 * начальник склада выбирает донора сам (тот же поиск, что и в разделе
 * "Без привязки к заданию", searchUnits) и сам решает, что из него
 * резать — включая/выключая предложенные строкой очереди куски, меняя их
 * ширину, добавляя свои. Дальше — либо сразу "Резать" (передаётся в тот
 * же CuttingForm через onCut, локи с production_task_line_id сняты —
 * оператор доредактирует участок/назначение там же), либо в печатный
 * "Список на резку" (onAddToBatch, тот же формат, что и у авто-плана). */
export default function ManualCuttingPlanModal({
  open,
  onClose,
  sku,
  rows,
  onCut,
  onAddToBatch,
}: {
  open: boolean;
  onClose: () => void;
  sku: MaterialSku;
  rows: QueueRowLike[];
  onCut: (donor: MaterialUnit, widthCuts: CuttingFormInitialWidthCut[]) => void;
  onAddToBatch: (entry: CuttingBatchEntryLike) => void;
}) {
  const [donor, setDonor] = useState<MaterialUnit | null>(null);
  const [pieces, setPieces] = useState<PieceRow[]>([]);

  const availableQuery = useQuery({
    queryKey: ["issue-manual-available", sku.id],
    queryFn: () =>
      searchUnits({
        material: sku.material.name,
        color: sku.color.name,
        thickness: sku.thickness.value_mm,
        manufacturer: sku.manufacturer.name,
        status: "На_хранении",
      }),
    enabled: open,
  });

  const calcSettingsQuery = useQuery({ queryKey: ["calc-settings"], queryFn: getCalcSettings });
  const minUsefulWidth = calcSettingsQuery.data?.min_useful_width_mm ?? 30;

  const pickDonor = (u: MaterialUnit) => {
    setDonor(u);
    setPieces(
      rows.map((r) => ({
        id: nextRowId(),
        enabled: true,
        width_mm: r.line.strip_width_mm || r.line.width_mm,
        label: r.line.part_name ?? "Деталь",
        production_task_line_id: r.line.id,
        area: r.task.area,
        custom: false,
      })),
    );
  };

  const addCustomRow = () =>
    setPieces((prev) => [...prev, { id: nextRowId(), enabled: true, width_mm: 0, label: "Ручной подбор", custom: true }]);
  const removeRow = (id: string) => setPieces((prev) => prev.filter((p) => p.id !== id));
  const updateRow = (id: string, patch: Partial<PieceRow>) =>
    setPieces((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  const includedPieces = useMemo(() => pieces.filter((p) => p.enabled && p.width_mm > 0), [pieces]);
  const widthSum = includedPieces.reduce((sum, p) => sum + p.width_mm, 0);
  const remainingWidth = donor ? Math.round((donor.width_mm - widthSum) * 100) / 100 : 0;
  const overflow = remainingWidth < 0;
  const remainderIsWaste = donor != null && includedPieces.length > 0 && remainingWidth > 0 && remainingWidth < minUsefulWidth;

  const reset = () => {
    setDonor(null);
    setPieces([]);
  };
  const close = () => {
    reset();
    onClose();
  };

  const buildWidthCuts = (): CuttingFormInitialWidthCut[] =>
    includedPieces.map((p) => ({
      width_mm: p.width_mm,
      area: p.area ?? "",
      production_task_line_id: p.production_task_line_id,
      label: p.label,
      locked: false,
    }));

  const handleCut = () => {
    if (!donor || includedPieces.length === 0) return;
    onCut(donor, buildWidthCuts());
    close();
  };

  const handleAddToBatch = () => {
    if (!donor || includedPieces.length === 0) return;
    onAddToBatch({
      donorUnitId: donor.id,
      donorWidthMm: donor.width_mm,
      donorLengthM: donor.length_m,
      wasteMm: Math.max(remainingWidth, 0),
      pieces: includedPieces.map((p) => ({ widthMm: p.width_mm, label: p.label })),
    });
    close();
  };

  return (
    <Modal title="Свой донор и раскрой" open={open} onCancel={close} footer={null} destroyOnHidden width={560}>
      {!donor ? (
        <>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
            Выберите рулон/штрипс на хранении под {sku.material.name}, {sku.color.name}, {sku.thickness.value_mm} мм —
            вместо предложенного системой.
          </Typography.Paragraph>
          <ResponsiveTable<MaterialUnit>
            size="small"
            rowKey="id"
            loading={availableQuery.isLoading}
            dataSource={availableQuery.data ?? []}
            pagination={false}
            scroll={{ x: "max-content" }}
            locale={{ emptyText: "Ничего нет на хранении" }}
            columns={[
              { title: "№", dataIndex: "id" },
              { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
              { title: "Ячейка", dataIndex: "location_code", render: (v) => v ?? "—" },
              {
                title: "",
                render: (_, u) => (
                  <Button size="small" type="primary" onClick={() => pickDonor(u)}>
                    Выбрать
                  </Button>
                ),
              },
            ]}
          />
        </>
      ) : (
        <>
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            Донор №{donor.id} — {donor.width_mm} мм × {donor.length_m} м
            {" · "}
            <a onClick={() => setDonor(null)}>сменить донора</a>
          </Typography.Paragraph>
          <Space direction="vertical" style={{ width: "100%" }} size="small">
            {pieces.map((p) => (
              <div key={p.id} style={{ border: "1px solid #EDEDE8", borderRadius: 8, padding: 8 }}>
                <Space wrap align="start">
                  <Checkbox checked={p.enabled} onChange={(e) => updateRow(p.id, { enabled: e.target.checked })} />
                  <InputNumber
                    min={1}
                    addonAfter="мм"
                    value={p.width_mm || undefined}
                    disabled={!p.enabled}
                    onChange={(v) => updateRow(p.id, { width_mm: v ?? 0 })}
                  />
                  {p.custom ? (
                    <Input
                      placeholder="Название"
                      style={{ width: 160 }}
                      value={p.label}
                      disabled={!p.enabled}
                      onChange={(e) => updateRow(p.id, { label: e.target.value })}
                    />
                  ) : (
                    <Typography.Text disabled={!p.enabled}>{p.label}</Typography.Text>
                  )}
                  <Button size="small" danger onClick={() => removeRow(p.id)}>
                    ✕
                  </Button>
                </Space>
              </div>
            ))}
            <Button onClick={addCustomRow} block>
              + Добавить свою ширину
            </Button>
            {includedPieces.length > 0 && (
              <Alert
                type={overflow ? "error" : remainderIsWaste ? "warning" : "info"}
                showIcon
                message={
                  overflow
                    ? `Суммарная ширина превышает донора на ${Math.abs(remainingWidth)} мм — снимите часть галочек или уменьшите ширины`
                    : remainingWidth === 0
                      ? "Ширины покрывают весь донор — остатка не будет"
                      : remainderIsWaste
                        ? `Остаток донора ${remainingWidth} мм — тоньше порога ${minUsefulWidth} мм, отход`
                        : `Остаток донора ${remainingWidth} мм останется на складе`
                }
              />
            )}
            <Space style={{ width: "100%" }} direction="vertical">
              <Button type="primary" block disabled={includedPieces.length === 0 || overflow} onClick={handleCut}>
                ✂️ Резать
              </Button>
              <Button block disabled={includedPieces.length === 0 || overflow} onClick={handleAddToBatch}>
                + В список на резку
              </Button>
            </Space>
          </Space>
        </>
      )}
    </Modal>
  );
}
