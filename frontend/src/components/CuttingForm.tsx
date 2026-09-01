import { useState } from "react";
import { Alert, Button, Card, DatePicker, InputNumber, Radio, Select, Space, Typography, message } from "antd";
import { isAxiosError } from "axios";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Dayjs } from "dayjs";
import dayjs from "dayjs";
import {
  executeCuttingRecipe,
  printLabelsBatch,
  skuLabel,
  type CuttingDestination,
  type CuttingRecipeResponse,
  type CuttingWidthSpec,
  type MaterialUnit,
} from "../api/units";
import { getCalcSettings } from "../api/abc";
import { suggestLocation, listWarehouses } from "../api/storage";
import LocationSelect from "./LocationSelect";
import { toOccurredAtIso } from "../utils/occurredAt";
import { useAuth } from "../auth/AuthContext";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

type LengthDestKind = "keep" | "issue" | "discard" | "transfer";
type WidthDestKind = "keep" | "issue" | "transfer";

interface WidthRow {
  id: string;
  width_mm: number;
  destination: WidthDestKind;
  area?: string;
  production_task_line_id?: number;
  actual_length_m?: number;
  location_code?: string;
  to_warehouse_id?: number;
  label?: string;
  locked?: boolean;
  // Ширина, подставленная из строки задания при открытии формы — чтобы
  // показать оператору, что он меняет значение относительно эталона, а
  // не просто вводит число с нуля (см. override_strip_width в submit).
  originalWidthMm?: number;
}

export interface CuttingFormInitialWidthCut {
  width_mm: number;
  area: string;
  production_task_line_id?: number;
  label?: string;
  locked?: boolean;
}

interface CuttingFormProps {
  donor: MaterialUnit;
  initialWidthCuts?: CuttingFormInitialWidthCut[];
  defaultArea?: string;
  areaOptions?: { value: string; label: string }[];
  // Раздел про площадки — предупреждение "не тот склад" (Issue.tsx уже
  // передаёт сюда confirmIfWrongWarehouse как есть, с тем же порядком
  // аргументов: склад единицы, участок назначения, колбэк подтверждения).
  confirmDestination?: (unitWarehouseName: string | null | undefined, area: string | undefined, onConfirmed: () => void) => void;
  onDone: (res: CuttingRecipeResponse) => void;
  onCancel: () => void;
}

let rowSeq = 0;
const nextRowId = () => `row-${++rowSeq}`;

/** Единая форма резки (раздел про объединение резки в одну форму) —
 * заменяет собой семь разрозненных действий, раньше раскиданных по
 * UnitCard.tsx ("Разделить"/"Раскрой") и Issue.tsx (резать+выдать одним
 * куском, план резки на несколько строк, то же самое в ручном подборе):
 * один донор → опциональный отрез по длине на всю ширину → ноль и более
 * кусков по ширине из остатка, каждый со своим назначением (оставить на
 * складе / выдать участку). Один вызов executeCuttingRecipe вместо
 * нескольких отдельных запросов и экранов. */
export default function CuttingForm({
  donor,
  initialWidthCuts = [],
  defaultArea,
  areaOptions = [],
  confirmDestination,
  onDone,
  onCancel,
}: CuttingFormProps) {
  const { user } = useAuth();
  const hasPermission = (code: string) => !!user?.is_superuser || !!user?.permissions.includes(code);
  const canSplit = hasPermission("units.split");
  const canCut = hasPermission("units.cut");
  const canIssue = hasPermission("units.issue");
  const canTransferPermission = hasPermission("warehouse_transfers.manage");
  // Раздел про правку штрипса прямо на выдаче — строки, привязанные к
  // строке задания (r.locked), обычно нельзя менять по ширине вообще
  // (см. override_strip_width в units.py — бэкенд и так примет
  // исправление, только если у пользователя есть это право, иначе всё
  // равно 409); без права смысла показывать редактируемое поле нет — оно
  // просто ошибётся при сохранении.
  const canOverrideStripWidth = hasPermission("production_tasks.manage");

  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });
  const activeWarehouses = (warehousesQuery.data ?? []).filter((w) => w.is_active);
  const warehouseOptions = activeWarehouses.map((w) => ({ value: w.id, label: w.name }));
  // Раздел про перемещение между складами — назначение "→ Перемещение"
  // имеет смысл, только если складов больше одного и у пользователя есть
  // право распоряжаться хабом (реальную проверку по факту выбранного
  // назначения всё равно делает бэкенд при отправке).
  const canTransfer = canTransferPermission && activeWarehouses.length > 1;

  const canWidthCut = donor.status === "На_хранении";

  const [lengthEnabled, setLengthEnabled] = useState(false);
  const [lengthM, setLengthM] = useState<number>();
  const [lengthDestKind, setLengthDestKind] = useState<LengthDestKind>(canCut ? "discard" : canSplit ? "keep" : "issue");
  const [lengthArea, setLengthArea] = useState<string | undefined>(defaultArea);
  const [lengthLocation, setLengthLocation] = useState<string>();
  const [lengthToWarehouseId, setLengthToWarehouseId] = useState<number>();

  const [widthRows, setWidthRows] = useState<WidthRow[]>(() =>
    initialWidthCuts.map((w) => ({ id: nextRowId(), ...w, destination: "issue" as const, originalWidthMm: w.width_mm })),
  );
  const [occurredAt, setOccurredAt] = useState<Dayjs | null>(null);

  const calcSettingsQuery = useQuery({ queryKey: ["calc-settings"], queryFn: getCalcSettings });
  const minUsefulWidth = calcSettingsQuery.data?.min_useful_width_mm ?? 30;

  const widthSum = widthRows.reduce((sum, r) => sum + (r.width_mm || 0), 0);
  const remainingWidth = Math.round((donor.width_mm - widthSum) * 100) / 100;
  const remainingLength = Math.round((donor.length_m - (lengthEnabled ? lengthM || 0 : 0)) * 100) / 100;
  const remainderIsWaste = widthRows.length > 0 && remainingWidth > 0 && remainingWidth < minUsefulWidth;

  const addWidthRow = () => setWidthRows((rows) => [...rows, { id: nextRowId(), width_mm: 0, destination: "keep" }]);
  const removeWidthRow = (id: string) => setWidthRows((rows) => rows.filter((r) => r.id !== id));
  const updateWidthRow = (id: string, patch: Partial<WidthRow>) =>
    setWidthRows((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const applyLocationSuggestion = async (rowId: string | "length") => {
    const loc = await suggestLocation({ material_sku_id: donor.material_sku.id, is_strip: true });
    if (!loc) return;
    if (rowId === "length") setLengthLocation(loc);
    else updateWidthRow(rowId, { location_code: loc });
  };

  const mutation = useMutation({
    mutationFn: () => {
      const length_destination: CuttingDestination | undefined = lengthEnabled
        ? lengthDestKind === "discard"
          ? { kind: "discard", location_code: lengthLocation }
          : lengthDestKind === "issue"
            ? { kind: "issue", area: lengthArea }
            : lengthDestKind === "transfer"
              ? { kind: "transfer", to_warehouse_id: lengthToWarehouseId }
              : { kind: "keep", location_code: lengthLocation }
        : undefined;

      const width_cuts: CuttingWidthSpec[] = widthRows.map((r) => ({
        width_mm: r.width_mm,
        destination:
          r.destination === "issue"
            ? { kind: "issue", area: r.area, production_task_line_id: r.production_task_line_id }
            : r.destination === "transfer"
              ? { kind: "transfer", to_warehouse_id: r.to_warehouse_id }
              : { kind: "keep", location_code: r.location_code },
        actual_length_m: r.destination === "issue" ? r.actual_length_m ?? remainingLength : undefined,
        // Пока идёт тестирование размеров штрипсов — если оператор поменял
        // ширину вручную (относительно того, что подставилось из строки
        // задания), бэкенд примет её как исправление и запомнит в строке
        // задания вместо отказа 409 (при наличии права production_tasks.
        // manage — иначе несовпадение по-прежнему блокируется).
        override_strip_width: r.destination === "issue" && r.production_task_line_id != null,
        // Раздел про замену плёнки на выдаче — донор может быть другой
        // номенклатурой, чем указано в строке задания (например, точной
        // сейчас нет на складе); тот же флаг для материала, тоже
        // применяется только при наличии права production_tasks.manage.
        override_material: r.destination === "issue" && r.production_task_line_id != null,
      }));

      return executeCuttingRecipe({
        donor_unit_id: donor.id,
        length_precut_m: lengthEnabled ? lengthM : undefined,
        length_destination,
        width_cuts,
        occurred_at: toOccurredAtIso(occurredAt),
      });
    },
    onSuccess: (res) => {
      const ids = [res.length_result?.unit.id, ...res.width_results.map((w) => w.unit.id)].filter(
        (id): id is number => id != null,
      );
      const flagged = res.width_results.filter((w) => w.discrepancy_flagged);
      if (ids.length > 0) printLabelsBatch(ids, { kind: "cutting_issue" });
      message.success(
        <>
          Разрезано {ids.length > 0 ? `— ${ids.map((id) => `№${id}`).join(", ")}` : ""}
          {res.donor_remainder.status === "Списан" && <> · остаток донора списан автоматически (отход)</>}
          {flagged.length > 0 && <> · ⚠️ заметное отклонение по: {flagged.map((w) => `№${w.unit.id}`).join(", ")}</>}
        </>,
      );
      onDone(res);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось выполнить резку")),
  });

  const submit = () => {
    if (!lengthEnabled && widthRows.length === 0) {
      message.warning("Добавьте хотя бы один отрез");
      return;
    }
    if (widthRows.some((r) => !r.width_mm || r.width_mm <= 0)) {
      message.warning("Укажите ширину для каждого куска");
      return;
    }
    if (lengthEnabled && lengthDestKind === "issue" && !lengthArea) {
      message.warning("Укажите участок для отреза по длине");
      return;
    }
    if (widthRows.some((r) => r.destination === "issue" && !r.area)) {
      message.warning("Укажите участок для каждого куска на выдачу");
      return;
    }
    if (lengthEnabled && lengthDestKind === "transfer" && !lengthToWarehouseId) {
      message.warning("Укажите склад назначения для отреза по длине");
      return;
    }
    if (widthRows.some((r) => r.destination === "transfer" && !r.to_warehouse_id)) {
      message.warning("Укажите склад назначения для каждого куска на перемещение");
      return;
    }
    const issueAreas: (string | undefined)[] = [];
    if (lengthEnabled && lengthDestKind === "issue") issueAreas.push(lengthArea);
    for (const r of widthRows) if (r.destination === "issue") issueAreas.push(r.area);

    if (confirmDestination && issueAreas.length > 0) {
      const confirmNext = (i: number) => {
        if (i >= issueAreas.length) {
          mutation.mutate();
          return;
        }
        confirmDestination(donor.warehouse_name, issueAreas[i], () => confirmNext(i + 1));
      };
      confirmNext(0);
    } else {
      mutation.mutate();
    }
  };

  return (
    <Card size="small" style={{ marginTop: 16 }}>
      <Typography.Paragraph style={{ marginBottom: 8 }}>
        Донор №{donor.id} — {skuLabel(donor.material_sku)}, {donor.width_mm} мм × {donor.length_m} м
        {donor.warehouse_name ? ` · ${donor.warehouse_name}` : ""}
      </Typography.Paragraph>

      {(canCut || canSplit || canIssue || canTransfer) && (
        <Card
          size="small"
          type="inner"
          title={
            <label>
              <input type="checkbox" checked={lengthEnabled} onChange={(e) => setLengthEnabled(e.target.checked)} style={{ marginRight: 8 }} />
              Сначала отрезать по длине (на всю ширину донора)
            </label>
          }
          style={{ marginBottom: 12 }}
        >
          {lengthEnabled && (
            <Space direction="vertical" style={{ width: "100%" }} size="small">
              <InputNumber
                min={0.01}
                max={donor.length_m}
                step={0.01}
                addonAfter="м"
                style={{ width: "100%" }}
                placeholder="Сколько отрезать, м"
                value={lengthM}
                onChange={(v) => setLengthM(v ?? undefined)}
              />
              <Radio.Group value={lengthDestKind} onChange={(e) => setLengthDestKind(e.target.value)}>
                {canSplit && <Radio.Button value="keep">Оставить на складе</Radio.Button>}
                {canIssue && <Radio.Button value="issue">Выдать участку</Radio.Button>}
                {canCut && <Radio.Button value="discard">Списать сразу</Radio.Button>}
                {canTransfer && <Radio.Button value="transfer">→ Перемещение</Radio.Button>}
              </Radio.Group>
              {lengthDestKind === "issue" && (
                <Select
                  placeholder="Участок"
                  style={{ width: "100%" }}
                  options={areaOptions}
                  value={lengthArea}
                  onChange={setLengthArea}
                />
              )}
              {lengthDestKind === "transfer" && (
                <Select
                  placeholder="Склад назначения"
                  style={{ width: "100%" }}
                  options={warehouseOptions}
                  value={lengthToWarehouseId}
                  onChange={setLengthToWarehouseId}
                />
              )}
              {(lengthDestKind === "keep" || lengthDestKind === "discard") && (
                <Space.Compact style={{ width: "100%" }}>
                  <LocationSelect
                    sku={donor.material_sku}
                    value={lengthLocation}
                    onChange={setLengthLocation}
                    placeholder={lengthDestKind === "keep" ? "Ячейка для куска (опционально)" : "Ячейка для остатка (опционально)"}
                  />
                  <Button onClick={() => applyLocationSuggestion("length")}>Подобрать</Button>
                </Space.Compact>
              )}
            </Space>
          )}
        </Card>
      )}

      {canWidthCut ? (
        <Card size="small" type="inner" title="Ширины из остатка">
          <Space direction="vertical" style={{ width: "100%" }} size="small">
            {widthRows.map((r) => (
              <div key={r.id} style={{ border: "1px solid #EDEDE8", borderRadius: 8, padding: 8 }}>
                <Space wrap style={{ width: "100%" }} align="start">
                  {r.label && (
                    <Typography.Text strong style={{ minWidth: 120 }}>
                      {r.label}
                    </Typography.Text>
                  )}
                  <InputNumber
                    min={1}
                    addonAfter="мм"
                    placeholder="Ширина"
                    disabled={r.locked && !canOverrideStripWidth}
                    value={r.width_mm || undefined}
                    onChange={(v) => updateWidthRow(r.id, { width_mm: v ?? 0 })}
                  />
                  {r.production_task_line_id != null && r.originalWidthMm != null && r.width_mm !== r.originalWidthMm && (
                    <Typography.Text type="warning" style={{ fontSize: 12 }}>
                      Было {r.originalWidthMm} мм — при сохранении обновит эталон в задании
                    </Typography.Text>
                  )}
                  {!r.locked && (
                    <Radio.Group
                      value={r.destination}
                      onChange={(e) => updateWidthRow(r.id, { destination: e.target.value })}
                    >
                      {canSplit && <Radio.Button value="keep">Склад</Radio.Button>}
                      {canIssue && <Radio.Button value="issue">Выдать</Radio.Button>}
                      {canTransfer && <Radio.Button value="transfer">Перемещение</Radio.Button>}
                    </Radio.Group>
                  )}
                  {r.destination === "issue" ? (
                    <>
                      {!r.locked && (
                        <Select
                          placeholder="Участок"
                          style={{ width: 160 }}
                          options={areaOptions}
                          value={r.area}
                          onChange={(v) => updateWidthRow(r.id, { area: v })}
                        />
                      )}
                      <InputNumber
                        min={0}
                        step={0.01}
                        addonAfter="м"
                        placeholder="Контрольная длина"
                        value={r.actual_length_m ?? remainingLength}
                        onChange={(v) => updateWidthRow(r.id, { actual_length_m: v ?? undefined })}
                      />
                    </>
                  ) : r.destination === "transfer" ? (
                    <Select
                      placeholder="Склад назначения"
                      style={{ width: 180 }}
                      options={warehouseOptions}
                      value={r.to_warehouse_id}
                      onChange={(v) => updateWidthRow(r.id, { to_warehouse_id: v })}
                    />
                  ) : (
                    <Space.Compact>
                      <LocationSelect
                        sku={donor.material_sku}
                        value={r.location_code}
                        onChange={(v) => updateWidthRow(r.id, { location_code: v })}
                        placeholder="Ячейка (опционально)"
                      />
                      <Button onClick={() => applyLocationSuggestion(r.id)}>Подобрать</Button>
                    </Space.Compact>
                  )}
                  {!r.locked && (
                    <Button size="small" danger onClick={() => removeWidthRow(r.id)}>
                      ✕
                    </Button>
                  )}
                </Space>
              </div>
            ))}
            <Button onClick={addWidthRow} block>
              + Добавить ширину
            </Button>
            {widthRows.length > 0 && (
              <Alert
                type={remainderIsWaste ? "warning" : "info"}
                showIcon
                message={
                  remainingWidth <= 0
                    ? "Ширины покрывают весь донор — остатка не будет"
                    : remainderIsWaste
                      ? `Остаток донора ${remainingWidth} мм — тоньше порога ${minUsefulWidth} мм, спишется автоматически как отход`
                      : `Остаток донора ${remainingWidth} мм останется на складе`
                }
              />
            )}
          </Space>
        </Card>
      ) : (
        <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
          Единица уже выдана участку — резка по ширине недоступна, только по длине.
        </Typography.Text>
      )}

      <DatePicker
        style={{ width: "100%", marginTop: 12 }}
        format="DD.MM.YYYY"
        placeholder="Дата операции: сейчас"
        value={occurredAt}
        onChange={setOccurredAt}
        disabledDate={(d) => d.isAfter(dayjs(), "day")}
      />

      <Button type="primary" block style={{ marginTop: 16 }} loading={mutation.isPending} onClick={submit}>
        Выполнить резку
      </Button>
      <Button block style={{ marginTop: 8 }} onClick={onCancel}>
        Отмена
      </Button>
    </Card>
  );
}
