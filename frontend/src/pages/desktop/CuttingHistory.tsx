import { useState } from "react";
import { Button, DatePicker, InputNumber, Modal, Space, Tag, Tooltip, Typography, message } from "antd";
import { isAxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs, { type Dayjs } from "dayjs";
import {
  getCuttingOperations,
  getUnit,
  printLabelsBatch,
  undoCuttingOperation,
  type CuttingOperation,
  type MaterialUnit,
} from "../../api/units";
import { listAreas } from "../../api/areas";
import ResponsiveTable from "../../components/ResponsiveTable";
import CuttingForm from "../../components/CuttingForm";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

function destinationLabel(kind: string, area: string | null, areaLabel: (code: string) => string): string {
  if (kind === "issue") return `выдан участку «${area ? areaLabel(area) : "?"}»`;
  if (kind === "transfer") return "в перемещении";
  return "на складе";
}

/** История резки (раздел про отмену резки) — вторая вкладка «Заготовок»,
 * журнал каждого вызова единой резки донора (execute_cutting_recipe):
 * что нарезано, кем, можно ли отменить прямо сейчас (сервер сам решает —
 * can_undo/cannot_undo_reason из services/cutting_undo.py, тут только
 * отображаем), печать этикеток и повторная резка того же донора. */
export default function CuttingHistory() {
  const [range, setRange] = useState<[Dayjs, Dayjs]>([dayjs().subtract(6, "day"), dayjs()]);
  const [donorUnitId, setDonorUnitId] = useState<number | null>(null);
  const [includeUndone, setIncludeUndone] = useState(false);
  const [recutDonor, setRecutDonor] = useState<MaterialUnit | null>(null);
  const queryClient = useQueryClient();

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;

  const query = useQuery({
    queryKey: [
      "cutting-operations",
      range[0].format("YYYY-MM-DD"),
      range[1].format("YYYY-MM-DD"),
      donorUnitId,
      includeUndone,
    ],
    queryFn: () =>
      getCuttingOperations({
        date_from: range[0].format("YYYY-MM-DD"),
        date_to: range[1].format("YYYY-MM-DD"),
        donor_unit_id: donorUnitId ?? undefined,
        include_undone: includeUndone,
      }),
  });

  const undoMutation = useMutation({
    mutationFn: undoCuttingOperation,
    onSuccess: () => {
      message.success("Резка отменена, донор восстановлен");
      queryClient.invalidateQueries({ queryKey: ["cutting-operations"] });
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось отменить резку")),
  });

  const recutMutation = useMutation({
    mutationFn: (unitId: number) => getUnit(unitId),
    onSuccess: setRecutDonor,
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось загрузить донора")),
  });

  const rows = query.data ?? [];

  const confirmUndo = (op: CuttingOperation) => {
    const pieces = op.resulting_pieces.map((p) => `№${p.id} (${p.width_mm}×${p.length_m} м)`).join(", ") || "—";
    Modal.confirm({
      title: "Отменить резку?",
      width: 480,
      content: (
        <div>
          <p>
            Донор №{op.donor_unit_id} вернётся к {op.donor_width_before_mm}×{op.donor_length_before_m} м.
          </p>
          <p>Будут удалены куски: {pieces}.</p>
          <p>Записи в журнале движений за эту резку будут удалены.</p>
        </div>
      ),
      okText: "Отменить резку",
      okButtonProps: { danger: true },
      cancelText: "Не отменять",
      onOk: () => undoMutation.mutateAsync(op.id),
    });
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Каждая резка донора — одной строкой: что было нарезано, кем и когда. Отменить можно только в течение 2 часов
        после резки и только пока ни один из кусков ещё не тронут (не выдан, не перемещён, не списан, не разрезан
        снова) — если кнопка недоступна, наведите на неё, чтобы увидеть точную причину.
      </Typography.Paragraph>
      <Space wrap>
        <DatePicker.RangePicker value={range} onChange={(v) => v && v[0] && v[1] && setRange([v[0], v[1]])} />
        <InputNumber
          placeholder="№ донора"
          style={{ width: 140 }}
          min={1}
          value={donorUnitId ?? undefined}
          onChange={(v) => setDonorUnitId(typeof v === "number" ? v : null)}
        />
        <Button
          type={includeUndone ? "primary" : "default"}
          onClick={() => setIncludeUndone((v) => !v)}
        >
          {includeUndone ? "Показаны и отменённые" : "Показать и отменённые"}
        </Button>
      </Space>

      <ResponsiveTable<CuttingOperation>
        rowKey="id"
        cardBreakpoint="md"
        loading={query.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: "Когда",
            key: "created_at",
            render: (_, r) => new Date(r.created_at).toLocaleString("ru-RU"),
            sorter: (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
            defaultSortOrder: "descend",
          },
          {
            title: "Донор",
            key: "donor",
            render: (_, r) => (
              <span>
                №{r.donor_unit_id} — {r.donor_material_sku.material.name}, {r.donor_material_sku.color.name},{" "}
                {r.donor_material_sku.thickness.value_mm} мм
                <br />
                {r.donor_width_before_mm}×{r.donor_length_before_m} → {r.donor_width_after_mm}×{r.donor_length_after_m} м
                {r.donor_auto_written_off && <Tag color="red" style={{ marginLeft: 6 }}>остаток списан</Tag>}
              </span>
            ),
          },
          {
            title: "Что нарезано",
            key: "pieces",
            render: (_, r) =>
              r.resulting_pieces.length === 0 ? (
                <Typography.Text type="secondary">без куска (отрезано в отход)</Typography.Text>
              ) : (
                <Space direction="vertical" size={2}>
                  {r.resulting_pieces.map((p) => (
                    <span key={p.id}>
                      №{p.id}: {p.width_mm}×{p.length_m} м — {destinationLabel(p.destination_kind, p.area, areaLabel)}
                    </span>
                  ))}
                </Space>
              ),
          },
          { title: "Кто выполнил", key: "user", render: (_, r) => r.user_name },
          {
            title: "Статус",
            key: "status",
            render: (_, r) =>
              r.undone_at ? (
                <Tooltip title={`${r.undone_by_name ?? ""}, ${new Date(r.undone_at).toLocaleString("ru-RU")}`}>
                  <Tag>отменена</Tag>
                </Tooltip>
              ) : (
                <Tag color="green">активна</Tag>
              ),
          },
          {
            title: "Действия",
            key: "actions",
            render: (_, r) => (
              <Space>
                <Tooltip title={!r.can_undo ? r.cannot_undo_reason : undefined}>
                  <Button
                    size="small"
                    danger
                    disabled={!r.can_undo}
                    loading={undoMutation.isPending && undoMutation.variables === r.id}
                    onClick={() => confirmUndo(r)}
                  >
                    Отменить
                  </Button>
                </Tooltip>
                <Button
                  size="small"
                  disabled={r.resulting_pieces.length === 0 || !!r.undone_at}
                  onClick={() => printLabelsBatch(r.resulting_pieces.map((p) => p.id), { kind: "cutting_issue" })}
                >
                  Печать этикеток
                </Button>
                <Button
                  size="small"
                  disabled={!!r.undone_at}
                  loading={recutMutation.isPending && recutMutation.variables === r.donor_unit_id}
                  onClick={() => recutMutation.mutate(r.donor_unit_id)}
                >
                  Резать ещё раз
                </Button>
              </Space>
            ),
          },
        ]}
      />

      {recutDonor && (
        <Modal title={`Резать донора №${recutDonor.id}`} open onCancel={() => setRecutDonor(null)} footer={null} destroyOnHidden width={560}>
          <CuttingForm
            donor={recutDonor}
            onDone={() => {
              setRecutDonor(null);
              queryClient.invalidateQueries({ queryKey: ["cutting-operations"] });
            }}
            onCancel={() => setRecutDonor(null)}
          />
        </Modal>
      )}
    </Space>
  );
}
