import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Collapse,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import dayjs from "dayjs";
import {
  executeCuttingPlan,
  getCuttingPlan,
  getReturnPreview,
  issueDonorAtomic,
  issueUnit,
  issueUnitDirect,
  placeUnit,
  printLabel,
  printLabelsBatch,
  returnUnit,
  searchUnits,
  skuLabel,
  type AreaValue,
  type IssueResult,
  type MaterialSku,
  type MaterialUnit,
} from "../../api/units";
import { suggestLocation } from "../../api/storage";
import { listMaterialSkus } from "../../api/dictionaries";
import { createShopFloorPurchaseRequest, type PurchaseRequestShopFloorCreate } from "../../api/purchasing";
import { listAreas } from "../../api/areas";
import {
  listProductionTasks,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineAssignment,
  type ProductionTaskLineIssuedUnit,
} from "../../api/production";
import ResponsiveTable from "../../components/ResponsiveTable";
import { useAuth } from "../../auth/AuthContext";

function issueErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

function findSku(skus: MaterialSku[] | undefined, material: string, color: string, thickness: number) {
  return skus?.find(
    (s) =>
      s.material.name.toLowerCase() === material.toLowerCase() &&
      s.color.name.toLowerCase() === color.toLowerCase() &&
      Math.abs(s.thickness.value_mm - thickness) < 0.01,
  );
}

interface IssuePrefill {
  material?: string;
  color?: string;
  thickness?: number;
  manufacturer?: string;
}

interface QueueSelection {
  task: ProductionTask;
  line: ProductionTaskLine;
  assignment?: ProductionTaskLineAssignment;
}

type QueueRowData = { task: ProductionTask; line: ProductionTaskLine; assignment?: ProductionTaskLineAssignment; overdue?: boolean };

/** Сколько метров плёнки реально нужно под ОДНУ строку очереди (раздел про
 * общий погонаж партии деталей, не длину одной детали) — "сегодня"-строка
 * привязана к конкретной бригаде/линии на день (assignment), ей нужен один
 * штрипс на ЕЁ количество на сегодня; параллельные бригады на ту же строку
 * задания — это отдельные assignment-записи и отдельные строки очереди
 * (groupQueueRows их не схлопывает), каждая посчитает свою длину сама, так
 * что "3 бригады параллельно = 3 отдельных штрипса" получается само собой,
 * без специальной логики. "Неделя"-строка (ещё не распределено по
 * бригадам) — весь оставшийся долг строки одним куском (shortfall_length_m,
 * его можно будет разрезать на месте по длине под нужное число бригад,
 * когда распределение появится). */
function neededLengthM(row: QueueRowData): number {
  return row.assignment ? row.assignment.quantity_pieces * row.line.length_m : row.line.shortfall_length_m;
}

/** Одна и та же плёнка на нескольких заданиях участка, независимо от
 * ширины штрипса (раздел про объединение требований + план резки на
 * несколько разных ширин) — раньше на очереди выдачи это были никак не
 * связанные строки, хотя по факту это один и тот же рулон, который можно
 * резать под несколько заданий сразу. Группировка по плёнке (без ширины
 * в ключе) — щелевая резка режет донора на несколько разных ширин за
 * один проход, поэтому даже разноширинные потребности одной плёнки
 * выгодно резать вместе (см. CuttingPlanHint ниже). Сама выдача
 * остаётся построчной (каждая линия — свой список/своя точная длина). */
function groupQueueRows(rows: QueueRowData[]) {
  const order: string[] = [];
  const groups = new Map<string, { key: string; material: string; color: string; thickness: number; rows: QueueRowData[] }>();
  for (const r of rows) {
    const key = `${r.task.area}|${r.line.material}|${r.line.color}|${r.line.thickness}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, material: r.line.material, color: r.line.color, thickness: r.line.thickness, rows: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.rows.push(r);
  }
  return order.map((k) => groups.get(k)!);
}

/** Подсказка плана резки для группы разноширинных потребностей одной
 * плёнки (раздел про несколько разных ширин штрипса на один день) —
 * щелевая резка режет донора на несколько полос за проход, так что вместо
 * резки каждой линии отдельно от своего донора выгоднее резать один
 * донор сразу под несколько нужных ширин. "Взять в работу" открывает
 * форму, которая режет и выдаёт все покрытые строки одним действием (см.
 * CuttingPlanExecuteModal) — план и выдача больше не два независимых
 * потока: строки, которых план не покрыл (uncovered), по-прежнему идут
 * через обычный клик по строке (независимый одноширинный подбор). */
function CuttingPlanHint({
  material,
  color,
  thickness,
  manufacturer,
  rows,
}: {
  material: string;
  color: string;
  thickness: number;
  manufacturer: string | undefined;
  rows: QueueRowData[];
}) {
  const navigate = useNavigate();
  const [executeOpen, setExecuteOpen] = useState(false);
  const widths = rows.map((r) => r.line.strip_width_mm || r.line.width_mm);
  const planQuery = useQuery({
    queryKey: ["cutting-plan", material, color, thickness, manufacturer, widths.join(",")],
    queryFn: () => getCuttingPlan({ material, color, thickness, manufacturer: manufacturer!, needed_widths_mm: widths }),
    enabled: !!manufacturer,
  });

  if (!manufacturer || !planQuery.data) return null;
  const { donor, covered_widths_mm, uncovered_widths_mm, waste_mm, covered_indices } = planQuery.data;

  if (!donor) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
        ✂️ Подходящего донора для резки на все эти ширины среди остатков нет — резать новый рулон.
      </Typography.Text>
    );
  }

  const coveredRows = covered_indices.map((i) => rows[i]);

  return (
    <>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
        ✂️ План резки: донор{" "}
        <a onClick={() => navigate("/m/unit-card", { state: { unitId: donor.unit_id } })}>№{donor.unit_id}</a> (
        {donor.width_mm} мм, {donor.length_m} м) → режем {covered_widths_mm.join(" + ")} мм, отход {waste_mm} мм
        {uncovered_widths_mm.length > 0 && <> · ещё нет донора на {uncovered_widths_mm.join(", ")} мм</>}
        {" · "}
        <a onClick={() => setExecuteOpen(true)}>Взять в работу</a>
      </Typography.Text>
      {executeOpen && (
        <CuttingPlanExecuteModal donor={donor} rows={coveredRows} onClose={() => setExecuteOpen(false)} />
      )}
    </>
  );
}

/** Исполнение плана резки одним действием (раздел про несколько ширин за
 * проход) — без отдельного статуса "в резке": форма открывается сразу с
 * предзаполненными по плану кусками, оператор тут же вводит контрольные
 * (реально отмотанные станком) длины и отправляет — резка и выдача по
 * всем строкам выполняются одним атомарным запросом
 * (POST /units/cutting-plan/execute). Расхождение с теоретической длиной
 * не блокирует отправку — только помечается в ответе и уходит в отчёт
 * "Отклонения при резке", тем же приёмом, что уже был бы у диалога
 * возврата, но сохраняется, а не теряется после разового подтверждения. */
function CuttingPlanExecuteModal({
  donor,
  rows,
  onClose,
}: {
  donor: { unit_id: number; width_mm: number; length_m: number };
  rows: QueueRowData[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [lengths, setLengths] = useState<Record<number, number>>(() =>
    Object.fromEntries(rows.map((r) => [r.line.id, donor.length_m])),
  );

  const executeMutation = useMutation({
    mutationFn: () =>
      executeCuttingPlan({
        donor_unit_id: donor.unit_id,
        cuts: rows.map((r) => ({
          production_task_line_id: r.line.id,
          width_mm: r.line.strip_width_mm || r.line.width_mm,
          actual_length_m: lengths[r.line.id] ?? donor.length_m,
        })),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["units-unplaced"] });
      qc.invalidateQueries({ queryKey: ["cutting-plan"] });
      const flagged = res.cuts.filter((c) => c.discrepancy_flagged);
      const unitIds = res.cuts.map((c) => c.unit.id);
      message.success(
        <>
          Разрезано и выдано {res.cuts.length} шт. ({unitIds.map((id) => `№${id}`).join(", ")}) —{" "}
          <a onClick={() => printLabelsBatch(unitIds, { kind: "cutting_issue" })}>печать этикеток</a>
          {flagged.length > 0 && (
            <>
              {" "}
              · ⚠️ заметное отклонение по: {flagged.map((c) => `№${c.unit.id}`).join(", ")} — попадёт в отчёт «Отклонения при
              резке».
            </>
          )}
        </>,
      );
      onClose();
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось выполнить план резки")),
  });

  return (
    <Modal
      title={`Взять в работу донора №${donor.unit_id}`}
      open
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={560}
    >
      <Typography.Paragraph type="secondary">
        {donor.width_mm} мм, {donor.length_m} м — режем сразу на {rows.length} {rows.length === 1 ? "штрипс" : "штрипса"}.
        Длина по умолчанию — расчётная (как у донора); поправьте на контрольную длину со станка, если она отличается.
      </Typography.Paragraph>
      <Space direction="vertical" style={{ width: "100%" }} size="small">
        {rows.map((r) => (
          <div
            key={r.line.id}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid #EDEDE8" }}
          >
            <div style={{ flex: "1 1 auto", minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{r.line.part_name ?? "Деталь"}</div>
              <div style={{ fontSize: 12, color: "#8A8C99" }}>
                {r.task.product_model_name ?? r.task.name} · штрипс {r.line.strip_width_mm || r.line.width_mm} мм
              </div>
            </div>
            <InputNumber
              min={0}
              step={0.01}
              style={{ width: 130 }}
              value={lengths[r.line.id]}
              addonAfter="м"
              onChange={(v) => setLengths((s) => ({ ...s, [r.line.id]: v ?? 0 }))}
            />
          </div>
        ))}
      </Space>
      <Button type="primary" block style={{ marginTop: 16 }} loading={executeMutation.isPending} onClick={() => executeMutation.mutate()}>
        Разрезать и выдать все строки
      </Button>
      <Button block style={{ marginTop: 8 }} onClick={onClose}>
        Отмена
      </Button>
    </Modal>
  );
}

interface IssuedResult {
  unit: MaterialUnit;
  remainder: MaterialUnit | null;
  remainderPlaced: boolean;
}

export default function Issue() {
  const location = useLocation();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canReturn = !!user?.is_superuser || !!user?.permissions.includes("units.return");
  const prefill = (location.state as IssuePrefill | null) ?? undefined;

  const [selected, setSelected] = useState<QueueSelection | null>(null);
  const [areaFilter, setAreaFilter] = useState<AreaValue | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<IssueResult | null>(null);
  const [lastIssued, setLastIssued] = useState<IssuedResult | null>(null);

  const [manualSkuId, setManualSkuId] = useState<number | null>(null);
  const [manualArea, setManualArea] = useState<AreaValue | null>(null);
  const [manualForm] = Form.useForm<{ width_mm: number; length_m: number }>();
  const [shortageModalOpen, setShortageModalOpen] = useState(false);
  const [shortageForm] = Form.useForm<PurchaseRequestShopFloorCreate>();

  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus });
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));

  // --- Очередь: "запрошено сегодня/просрочено" (из распределения по дням)
  // и "задания недели" (остаток по строкам, для которых на сегодня ничего
  // не распределено) — раздел про экран выдачи: складу нужны
  // производственные задания, а не заказы покупателей.
  const today = dayjs().format("YYYY-MM-DD");

  // Строка попадает в очередь не по голому остатку штук, а по нехватке
  // уже выданной плёнки (shortfall_length_m, backend) — раздел про
  // «потребности» после выдачи: как только выдано достаточно на весь
  // план, строка уходит из очереди в «Выдано по заданиям», даже если
  // производство ещё не отчиталось о готовых деталях. Довыдача
  // открывается заново только отчётом о браке (см.
  // compute_shortfall_length_m) — сам факт остатка штук её не включает.
  const activeLines = useMemo(
    () =>
      (tasksQuery.data ?? []).flatMap((task) =>
        task.lines
          .filter((line) => line.remaining_pieces > 0 && line.shortfall_length_m > 0)
          .map((line) => ({ task, line })),
      ),
    [tasksQuery.data],
  );

  const assignmentRows = useMemo(() => {
    const rows = activeLines.flatMap(({ task, line }) =>
      (line.assignments ?? [])
        .filter((a) => a.date <= today)
        .map((assignment) => ({ task, line, assignment, overdue: assignment.date < today })),
    );
    rows.sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return a.assignment.date.localeCompare(b.assignment.date);
    });
    return rows;
  }, [activeLines, today]);

  const linesWithTodayAssignment = useMemo(() => new Set(assignmentRows.map((r) => r.line.id)), [assignmentRows]);
  const weekRows = useMemo(
    () => activeLines.filter(({ line }) => !linesWithTodayAssignment.has(line.id)),
    [activeLines, linesWithTodayAssignment],
  );

  // "Выдано по заданиям" — по всем строкам, не только активным
  // (remaining_pieces > 0): завершённая строка с уже выданной плёнкой
  // остаётся в ленте расхода, это не список "что ещё нужно выдать".
  const issuedLines = useMemo(
    () =>
      (tasksQuery.data ?? []).flatMap((task) =>
        task.lines.filter((line) => line.issued_length_m > 0).map((line) => ({ task, line })),
      ),
    [tasksQuery.data],
  );

  const matchesFilter = (task: ProductionTask, line: ProductionTaskLine) => {
    if (areaFilter && task.area !== areaFilter) return false;
    if (search.trim()) {
      const haystack = `${line.part_name ?? ""} ${task.product_model_name ?? task.name ?? ""} ${line.material} ${line.color}`.toLowerCase();
      if (!haystack.includes(search.trim().toLowerCase())) return false;
    }
    return true;
  };

  const filteredAssignmentRows = assignmentRows.filter((r) => matchesFilter(r.task, r.line));
  const filteredWeekRows = weekRows.filter((r) => matchesFilter(r.task, r.line));

  const overdueCount = assignmentRows.filter((r) => r.overdue).length;
  const todayCount = assignmentRows.length - overdueCount;
  const areasWaiting = new Set([...assignmentRows, ...weekRows].map((r) => r.task.area)).size;

  // --- Выбранная потребность: авто-подбор точного/донор-штрипса сразу
  // после выбора строки в очереди, без лишнего клика "искать".
  const selectedSku = selected ? findSku(skusQuery.data, selected.line.material, selected.line.color, selected.line.thickness) : undefined;
  const selectedStripWidth = selected ? selected.line.strip_width_mm || selected.line.width_mm : 0;
  // Раздел про общий погонаж на партию деталей — раньше искали и выдавали
  // строго на ОДНУ деталь (line.length_m), даже когда по строке нужно
  // сразу несколько: 4 детали одной ширины оборачивались 4 отдельными
  // подборами донора (иногда — 4 разными физическими штрипсами), хотя
  // одного достаточной длины хватило бы на все 4 (порезать по длине уже
  // на участке). См. neededLengthM выше.
  const selectedNeededLengthM = selected ? neededLengthM(selected) : 0;

  const findMutation = useMutation({
    mutationFn: () =>
      issueUnit({
        material: selectedSku!.material.name,
        color: selectedSku!.color.name,
        thickness: selectedSku!.thickness.value_mm,
        manufacturer: selectedSku!.manufacturer.name,
        width_mm: selectedStripWidth,
        length_m: selectedNeededLengthM,
        area: selected!.task.area,
        production_task_line_id: selected!.line.id,
      }),
    onSuccess: (res) => {
      setResult(res);
      if (res.outcome === "issued" && res.unit) {
        setLastIssued({ unit: res.unit, remainder: null, remainderPlaced: false });
        qc.invalidateQueries({ queryKey: ["issue-available-units"] });
      }
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось подобрать штрипс")),
  });

  useEffect(() => {
    if (!selected || !selectedSku) return;
    setResult(null);
    setLastIssued(null);
    findMutation.mutate();
    // findMutation.mutate имеет стабильную идентичность между рендерами (react-query) — не в зависимостях намеренно
  }, [selected?.line.id, selectedSku?.id]);

  const availableQuery = useQuery({
    queryKey: ["issue-available-units", selectedSku?.id],
    queryFn: () =>
      searchUnits({
        material: selectedSku!.material.name,
        color: selectedSku!.color.name,
        thickness: selectedSku!.thickness.value_mm,
        manufacturer: selectedSku!.manufacturer.name,
        status: "На_хранении",
      }),
    enabled: !!selectedSku,
  });

  // --- Нехватка остатка под выбранную строку задания (раздел про замену
  // "Заказов покупателей" — нехватка обнаруживается в моменте выдачи, не
  // на отдельном экране планирования). needed — на весь довыдаваемый
  // остаток строки задания (shortfall_length_m — раздел про очередь
  // «потребности» после выдачи), не голый остаток по штукам: то, что уже
  // выдано, не должно завышать площадь для заявки на закупку.
  const neededM2 = selected ? (selectedStripWidth / 1000) * selected.line.shortfall_length_m : 0;
  const availableM2 = (availableQuery.data ?? []).reduce((sum, u) => sum + u.area_m2, 0);
  const shortfallM2 = Math.max(0, Math.round((neededM2 - availableM2) * 100) / 100);

  const shopFloorRequestMutation = useMutation({
    mutationFn: (payload: PurchaseRequestShopFloorCreate) => createShopFloorPurchaseRequest(payload),
    onSuccess: () => {
      message.success("Заявка на закупку отправлена");
      setShortageModalOpen(false);
    },
    onError: () => message.error("Не удалось создать заявку"),
  });

  const openShortageModal = () => {
    if (!selectedSku || !selected) return;
    shortageForm.setFieldsValue({
      material: selectedSku.material.name,
      color: selectedSku.color.name,
      thickness: selectedSku.thickness.value_mm,
      requested_area_m2: shortfallM2,
      note: `${selected.line.part_name ?? "Деталь"} — ${selected.task.product_model_name ?? selected.task.name ?? `Задание №${selected.task.id}`}`,
    });
    setShortageModalOpen(true);
  };

  const directMutation = useMutation({
    mutationFn: (unitId: number) => issueUnitDirect(unitId, selected!.task.area, selected!.line.id),
    onSuccess: (unit) => {
      setLastIssued({ unit, remainder: null, remainderPlaced: false });
      setResult(null);
      qc.invalidateQueries({ queryKey: ["issue-available-units"] });
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось выдать")),
  });

  const atomicDonorMutation = useMutation({
    mutationFn: (values: { donor_unit_id: number; requested_width_mm: number }) =>
      issueDonorAtomic({ ...values, area: selected!.task.area, production_task_line_id: selected!.line.id }),
    onSuccess: (res) => {
      setLastIssued({ unit: res.issued_unit, remainder: res.remainder_unit, remainderPlaced: false });
      setResult(null);
      qc.invalidateQueries({ queryKey: ["issue-available-units"] });
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось разрезать и выдать донора")),
  });

  const remainderSuggestion = useQuery({
    queryKey: ["suggest-location", "issue-remainder", lastIssued?.remainder?.id],
    queryFn: () =>
      suggestLocation({
        material_sku_id: lastIssued!.remainder!.material_sku.id,
        is_strip: lastIssued!.remainder!.is_strip,
      }),
    enabled: !!lastIssued?.remainder && !lastIssued.remainderPlaced,
  });

  const placeRemainderMutation = useMutation({
    mutationFn: (locationCode: string) => placeUnit(lastIssued!.remainder!.id, locationCode),
    onSuccess: () => {
      setLastIssued((prev) => (prev ? { ...prev, remainderPlaced: true } : prev));
      message.success("Остаток размещён");
    },
    onError: () => message.error("Не удалось разместить остаток"),
  });

  const finishAndReset = () => {
    setSelected(null);
    setResult(null);
    setLastIssued(null);
  };

  // --- Ручной подбор без привязки к заданию (редкий случай — плёнка не
  // относится ни к одному заданию). Строгая проверка соответствия здесь
  // не применяется, т.к. нет строки задания, с которой сверять.
  const manualSku = skusQuery.data?.find((s) => s.id === manualSkuId) ?? null;

  useEffect(() => {
    if (!prefill || !skusQuery.data) return;
    if (prefill.material && prefill.color && prefill.thickness) {
      const match = findSku(skusQuery.data, prefill.material, prefill.color, prefill.thickness);
      if (match) setManualSkuId(match.id);
    }
  }, [prefill, skusQuery.data]);

  const manualAvailableQuery = useQuery({
    queryKey: ["issue-manual-available", manualSkuId],
    queryFn: () =>
      searchUnits({
        material: manualSku!.material.name,
        color: manualSku!.color.name,
        thickness: manualSku!.thickness.value_mm,
        manufacturer: manualSku!.manufacturer.name,
        status: "На_хранении",
      }),
    enabled: !!manualSku,
  });

  const manualDirectMutation = useMutation({
    mutationFn: (unitId: number) => issueUnitDirect(unitId, manualArea!),
    onSuccess: (unit) => {
      setLastIssued({ unit, remainder: null, remainderPlaced: false });
      qc.invalidateQueries({ queryKey: ["issue-manual-available"] });
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось выдать")),
  });

  const manualFindMutation = useMutation({
    mutationFn: (v: { width_mm: number; length_m: number }) =>
      issueUnit({
        material: manualSku!.material.name,
        color: manualSku!.color.name,
        thickness: manualSku!.thickness.value_mm,
        manufacturer: manualSku!.manufacturer.name,
        width_mm: v.width_mm,
        length_m: v.length_m,
        area: manualArea!,
      }),
    onSuccess: (res) => {
      if (res.outcome === "issued" && res.unit) {
        setLastIssued({ unit: res.unit, remainder: null, remainderPlaced: false });
        qc.invalidateQueries({ queryKey: ["issue-manual-available"] });
      } else if (res.outcome === "not_found") {
        message.warning("Точного совпадения по ширине нет — донора тоже нет, режьте новый рулон");
      } else if (res.outcome === "donor_suggested" && res.donor) {
        message.info(`Есть донор №${res.donor.unit_id}, ${res.donor.width_mm} мм — откройте карточку единицы, чтобы разрезать`);
      }
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось оформить выдачу")),
  });

  const queueRow = (
    r: { task: ProductionTask; line: ProductionTaskLine; assignment?: ProductionTaskLineAssignment; overdue?: boolean },
    variant: "today" | "week",
  ) => {
    const isSelected = selected?.line.id === r.line.id && selected?.assignment?.id === r.assignment?.id;
    const sw = r.line.strip_width_mm || r.line.width_mm;
    return (
      <div
        key={`${r.line.id}-${r.assignment?.id ?? "week"}`}
        onClick={() => setSelected({ task: r.task, line: r.line, assignment: r.assignment })}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          marginBottom: 8,
          borderRadius: 10,
          borderTop: `1px solid ${isSelected ? "#C97A2B" : "#DEDEDA"}`,
          borderRight: `1px solid ${isSelected ? "#C97A2B" : "#DEDEDA"}`,
          borderBottom: `1px solid ${isSelected ? "#C97A2B" : "#DEDEDA"}`,
          borderLeft: r.overdue ? "3px solid #B8483C" : `1px solid ${isSelected ? "#C97A2B" : "#DEDEDA"}`,
          boxShadow: isSelected ? "0 0 0 2px #FBF0E3" : undefined,
          cursor: "pointer",
          background: "#fff",
        }}
      >
        {variant === "today" ? (
          <Tag color={r.overdue ? "error" : "orange"} style={{ margin: 0, flexShrink: 0 }}>
            {r.overdue ? `просрочено · ${dayjs(r.assignment!.date).format("DD.MM")}` : "сегодня"}
          </Tag>
        ) : (
          <Tag style={{ margin: 0, flexShrink: 0 }}>не распределено на сегодня</Tag>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>{r.line.part_name ?? "Деталь без названия"}</div>
          <div style={{ fontSize: 12.5, color: "#8A8C99" }}>
            {r.task.product_model_name ?? r.task.name ?? `Задание №${r.task.id}`} · {areaLabel(r.task.area)}
            {r.assignment ? ` · ${r.assignment.line_name} · ${r.assignment.employee_names}` : ""}
          </div>
          <Space size={4} style={{ marginTop: 4 }}>
            <Tag color="blue">штрипс {sw} мм</Tag>
            <Tag>{r.line.material}, {r.line.color}, {r.line.thickness} мм</Tag>
          </Space>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontWeight: 700 }}>
            {r.assignment
              ? `${r.assignment.quantity_pieces} шт (${neededLengthM(r).toFixed(2)} м)`
              : `довыдать ${r.line.shortfall_length_m} м`}
          </div>
          <div style={{ fontSize: 11.5, color: "#8A8C99" }}>
            {r.assignment ? `${r.line.length_m} м на штрипс` : `остаток ${r.line.remaining_pieces} шт`}
          </div>
        </div>
      </div>
    );
  };

  const renderQueueRows = (rows: QueueRowData[], variant: "today" | "week") =>
    groupQueueRows(rows).map((g) =>
      g.rows.length > 1 ? (
        <div
          key={g.key}
          style={{
            marginBottom: 12,
            padding: "10px 12px 2px",
            borderRadius: 10,
            background: "#FBF6EE",
            border: "1px dashed #D8B98A",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "#8A6A2F", marginBottom: 4 }}>
            🧩 Одна плёнка на {g.rows.length} задания: {g.material}, {g.color}, {g.thickness} мм — итого{" "}
            {g.rows.reduce((sum, r) => sum + neededLengthM(r), 0).toFixed(2)} м
          </div>
          <CuttingPlanHint
            material={g.material}
            color={g.color}
            thickness={g.thickness}
            manufacturer={findSku(skusQuery.data, g.material, g.color, g.thickness)?.manufacturer.name}
            rows={g.rows}
          />
          {g.rows.map((r) => queueRow(r, variant))}
        </div>
      ) : (
        queueRow(g.rows[0], variant)
      ),
    );

  return (
    <div>
      <Typography.Title level={4}>Выдача участку</Typography.Title>

      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title="Запрошено сегодня" value={todayCount} valueStyle={{ color: "#C97A2B" }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small" style={overdueCount > 0 ? { background: "#FBEAE7", borderColor: "#E3B5AC" } : undefined}>
            <Statistic title="Просрочено" value={overdueCount} valueStyle={{ color: overdueCount > 0 ? "#B8483C" : undefined }} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title="Строк в заданиях недели" value={weekRows.length} />
          </Card>
        </Col>
        <Col xs={12} sm={12} md={6}>
          <Card size="small">
            <Statistic title="Участков ждут выдачи" value={areasWaiting} />
          </Card>
        </Col>
      </Row>

      <Space style={{ marginBottom: 16, width: "100%" }}>
        <Select
          allowClear
          placeholder="Все участки"
          style={{ width: 220 }}
          options={areaOptions}
          value={areaFilter}
          onChange={setAreaFilter}
        />
        <Input.Search
          placeholder="Поиск по детали, заданию, плёнке…"
          style={{ width: 320 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
        />
      </Space>

      <Row gutter={[20, 20]}>
        <Col xs={24} lg={15}>
          <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography.Title level={5} style={{ margin: 0 }}>🔥 Запрошено сегодня</Typography.Title>
            <Tag>{filteredAssignmentRows.length}</Tag>
          </div>
          {filteredAssignmentRows.length === 0 ? (
            <Typography.Text type="secondary">Ничего не распределено на сегодня по выбранному фильтру.</Typography.Text>
          ) : (
            renderQueueRows(filteredAssignmentRows, "today")
          )}

          <div style={{ margin: "20px 0 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography.Title level={5} style={{ margin: 0 }}>📋 Задания участка — на неделю</Typography.Title>
            <Tag>{filteredWeekRows.length}</Tag>
          </div>
          {filteredWeekRows.length === 0 ? (
            <Typography.Text type="secondary">Остатка по заданиям, не распределённым на сегодня, нет.</Typography.Text>
          ) : (
            renderQueueRows(filteredWeekRows, "week")
          )}
        </Col>

        <Col xs={24} lg={9}>
          <div style={{ position: "sticky", top: 16 }}>
            {!selected && !lastIssued && (
              <Card style={{ textAlign: "center", padding: "24px 8px", color: "#8A8C99" }}>
                Выберите потребность слева — материал, штрипс и участок подставятся автоматически.
              </Card>
            )}

            {selected && !lastIssued && (
              <Card>
                <Typography.Title level={5}>{selected.line.part_name ?? "Деталь"}</Typography.Title>
                <table style={{ width: "100%", fontSize: 13, marginBottom: 14 }}>
                  <tbody>
                    <tr>
                      <td style={{ color: "#8A8C99", paddingRight: 12 }}>Задание</td>
                      <td style={{ fontWeight: 600 }}>
                        {selected.task.product_model_name ?? selected.task.name} · {areaLabel(selected.task.area)}
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: "#8A8C99" }}>Плёнка</td>
                      <td style={{ fontWeight: 600 }}>
                        {selected.line.material}, {selected.line.color}, {selected.line.thickness} мм
                      </td>
                    </tr>
                    <tr>
                      <td style={{ color: "#8A8C99" }}>Штрипс</td>
                      <td style={{ fontWeight: 700, color: "#2C4A73" }}>{selectedStripWidth} мм</td>
                    </tr>
                    <tr>
                      <td style={{ color: "#8A8C99" }}>Длина на штрипс</td>
                      <td style={{ fontWeight: 600 }}>{selected.line.length_m} м</td>
                    </tr>
                    {selected.assignment && (
                      <tr>
                        <td style={{ color: "#8A8C99" }}>Смена</td>
                        <td style={{ fontWeight: 600 }}>
                          {dayjs(selected.assignment.date).format("DD.MM.YYYY")}, {selected.assignment.line_name}, {selected.assignment.employee_names}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>

                {!selectedSku && (
                  <Typography.Text type="warning">
                    Такой номенклатуры материала нет в справочнике — выдача невозможна, обратитесь к начальнику склада.
                  </Typography.Text>
                )}

                {selectedSku && shortfallM2 > 0 && (
                  // message+action в один ряд (стандартный Alert) на узкой
                  // боковой панели планшета сжимал текст в колонку по
                  // одной букве — action всегда пытается влезть рядом с
                  // текстом. description+кнопка блоком друг под другом
                  // этого не делают ни при какой ширине.
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="Не хватает остатка на складе"
                    description={
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
                        <span>
                          Не хватает ~{shortfallM2} м² на весь остаток строки — на складе{" "}
                          {Math.round(availableM2 * 100) / 100} м², нужно {Math.round(neededM2 * 100) / 100} м²
                        </span>
                        <Button size="small" type="primary" onClick={openShortageModal}>
                          Подать заявку на закупку
                        </Button>
                      </div>
                    }
                  />
                )}

                {findMutation.isPending && <Typography.Text type="secondary">Подбираем штрипс…</Typography.Text>}

                {result?.outcome === "not_found" && (
                  <div style={{ background: "#FBEAE7", border: "1px solid #E3B5AC", borderRadius: 10, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, color: "#B8483C" }}>Точного штрипса и донора нет</div>
                    <div style={{ fontSize: 12.5, color: "#8C4238", marginTop: 4 }}>Режьте новый рулон вручную через карточку единицы.</div>
                  </div>
                )}

                {result?.outcome === "donor_suggested" && result.donor && (
                  <div style={{ background: "#FBF0E3", border: "1px solid #ECC79B", borderRadius: 10, padding: 12, marginBottom: 12 }}>
                    <div style={{ fontWeight: 700, color: "#A8631E" }}>
                      ⚡ Точного штрипса нет — есть донор №{result.donor.unit_id}
                    </div>
                    <div style={{ fontSize: 12.5, marginTop: 4 }}>
                      {result.donor.width_mm} мм, класс {result.donor.width_class}
                      {result.donor.days_in_storage !== undefined && result.donor.days_in_storage > 0 && (
                        <Tag color="volcano" style={{ marginLeft: 6 }}>лежалый {result.donor.days_in_storage} дн.</Tag>
                      )}
                      <br />
                      Отрежем {result.donor.recommended_cut_mm} мм, отход {result.donor.waste_mm} мм.
                    </div>
                    <Button
                      type="primary"
                      block
                      style={{ marginTop: 10 }}
                      loading={atomicDonorMutation.isPending}
                      onClick={() =>
                        atomicDonorMutation.mutate({
                          donor_unit_id: result.donor!.unit_id,
                          requested_width_mm: result.donor!.recommended_cut_mm,
                        })
                      }
                    >
                      ⚡ Разрезать и выдать
                    </Button>
                  </div>
                )}

                <Collapse
                  ghost
                  size="small"
                  items={[
                    {
                      key: "stock",
                      label: `Показать остатки на складе по этой номенклатуре (${availableQuery.data?.length ?? 0})`,
                      children: (
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
                              render: (_, u) =>
                                u.width_mm > selectedStripWidth ? (
                                  <Button
                                    size="small"
                                    loading={atomicDonorMutation.isPending}
                                    onClick={() =>
                                      atomicDonorMutation.mutate({ donor_unit_id: u.id, requested_width_mm: selectedStripWidth })
                                    }
                                  >
                                    Разрезать на {selectedStripWidth} мм
                                  </Button>
                                ) : u.width_mm === selectedStripWidth ? (
                                  <Button size="small" type="primary" loading={directMutation.isPending} onClick={() => directMutation.mutate(u.id)}>
                                    Выдать целиком
                                  </Button>
                                ) : (
                                  <Tag color="warning">уже{selectedStripWidth} мм больше</Tag>
                                ),
                            },
                          ]}
                        />
                      ),
                    },
                  ]}
                />
              </Card>
            )}

            {lastIssued && (
              <Card style={{ background: "#E7F5EE", borderColor: "#B7E0CD" }}>
                <Space align="center" style={{ marginBottom: 4 }}>
                  <span
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: "50%",
                      background: "#1D9E75",
                      color: "#fff",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    ✓
                  </span>
                  <Typography.Text strong style={{ color: "#146B4E", fontSize: 15 }}>
                    Выдано №{lastIssued.unit.id} — {lastIssued.unit.width_mm} мм × {lastIssued.unit.length_m} м
                  </Typography.Text>
                </Space>
                {lastIssued.remainder && (
                  <div style={{ marginLeft: 40, fontSize: 12.5, color: "#2E6B54", marginBottom: 14 }}>
                    Донор разрезан, остаток №{lastIssued.remainder.id} обновлён
                  </div>
                )}

                <Space direction="vertical" style={{ width: "100%", marginTop: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "#fff",
                      border: "1px solid #C7E5D6",
                      borderRadius: 9,
                      padding: "10px 12px",
                    }}
                  >
                    <span>🏷️ Бирка на выданный штрипс</span>
                    <Button size="small" onClick={() => printLabel(lastIssued.unit.id)}>Печать</Button>
                  </div>

                  {lastIssued.remainder && !lastIssued.remainderPlaced && (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        background: "#fff",
                        border: "1px solid #C7E5D6",
                        borderRadius: 9,
                        padding: "10px 12px",
                      }}
                    >
                      <span>
                        📦 Остаток №{lastIssued.remainder.id}, {lastIssued.remainder.width_mm} мм
                        {remainderSuggestion.data && (
                          <>
                            {" — рекомендуем "}
                            <Tag color="orange">{remainderSuggestion.data}</Tag>
                          </>
                        )}
                      </span>
                      <Button
                        size="small"
                        type="primary"
                        disabled={!remainderSuggestion.data}
                        loading={placeRemainderMutation.isPending}
                        onClick={() => placeRemainderMutation.mutate(remainderSuggestion.data!)}
                      >
                        Разместить
                      </Button>
                    </div>
                  )}
                  {lastIssued.remainder && lastIssued.remainderPlaced && (
                    <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                      Остаток размещён.
                    </Typography.Text>
                  )}
                </Space>

                <Button block style={{ marginTop: 14 }} onClick={finishAndReset}>
                  Готово — к следующей позиции
                </Button>
              </Card>
            )}

            <Collapse
              ghost
              style={{ marginTop: 12 }}
              items={[
                {
                  key: "manual",
                  label: "Без привязки к заданию (ручной подбор)",
                  children: (
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                        Для случаев, когда плёнка не относится ни к одному заданию — проба, списание и т.п. Строгая
                        проверка соответствия здесь не действует.
                      </Typography.Text>
                      <Select
                        showSearch
                        style={{ width: "100%" }}
                        placeholder="Позиция материала"
                        options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
                        filterOption={(input, option) => String(option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
                        value={manualSkuId ?? undefined}
                        onChange={(v) => setManualSkuId(v)}
                      />
                      <Select
                        style={{ width: "100%" }}
                        placeholder="Участок выдачи"
                        options={areaOptions}
                        value={manualArea ?? undefined}
                        onChange={(v) => setManualArea(v)}
                      />
                      {manualSku && (
                        <>
                          <ResponsiveTable<MaterialUnit>
                            size="small"
                            rowKey="id"
                            loading={manualAvailableQuery.isLoading}
                            dataSource={manualAvailableQuery.data ?? []}
                            pagination={false}
                            scroll={{ x: "max-content" }}
                            locale={{ emptyText: "Ничего нет на хранении" }}
                            columns={[
                              { title: "Ширина×длина", render: (_, u) => `${u.width_mm} мм × ${u.length_m} м` },
                              {
                                title: "",
                                render: (_, u) => (
                                  <Button
                                    size="small"
                                    type="primary"
                                    disabled={!manualArea}
                                    loading={manualDirectMutation.isPending}
                                    onClick={() => manualDirectMutation.mutate(u.id)}
                                  >
                                    Выдать целиком
                                  </Button>
                                ),
                              },
                            ]}
                          />
                          <Form form={manualForm} layout="inline" onFinish={(v) => manualFindMutation.mutate(v)}>
                            <Form.Item name="width_mm" rules={[{ required: true }]}>
                              <InputNumber placeholder="Ширина, мм" min={1} style={{ width: 120 }} />
                            </Form.Item>
                            <Form.Item name="length_m" rules={[{ required: true }]}>
                              <InputNumber placeholder="Длина, м" min={0.1} step={0.1} style={{ width: 120 }} />
                            </Form.Item>
                            <Button htmlType="submit" disabled={!manualArea} loading={manualFindMutation.isPending}>
                              Найти и выдать
                            </Button>
                          </Form>
                        </>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          </div>
        </Col>
      </Row>

      {issuedLines.length > 0 && (
        <Card style={{ marginTop: 20 }} title="📦 Выдано по заданиям — расход плёнки">
          <ResponsiveTable
            tableKey="issue-issued-lines"
            lockedColumns={["Задание"]}
            defaultHiddenColumns={["Деталь", "Плёнка", "Остаток задания, шт"]}
            size="small"
            rowKey={(r) => r.line.id}
            dataSource={issuedLines}
            pagination={{ pageSize: 10 }}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Задание", render: (_, r) => r.task.product_model_name ?? r.task.name ?? `Задание №${r.task.id}` },
              { title: "Деталь", render: (_, r) => r.line.part_name ?? "—" },
              { title: "Участок", render: (_, r) => areaLabel(r.task.area) },
              { title: "Плёнка", render: (_, r) => `${r.line.material}, ${r.line.color}, ${r.line.thickness} мм` },
              { title: "Выдано, м", render: (_, r) => r.line.issued_length_m.toFixed(1) },
              { title: "Хороших, шт", render: (_, r) => <Tag color="green">{r.line.produced_good_pieces}</Tag> },
              {
                title: "Брак, шт",
                render: (_, r) => (r.line.defect_pieces > 0 ? <Tag color="red">{r.line.defect_pieces}</Tag> : "—"),
              },
              { title: "Остаток задания, шт", render: (_, r) => r.line.remaining_pieces },
              {
                title: "Действия",
                render: (_, r) =>
                  r.line.issued_units.length > 0 && (
                    <Space direction="vertical" size={4}>
                      <a
                        onClick={() =>
                          printLabelsBatch(
                            r.line.issued_units.map((u) => u.id),
                            { kind: "cutting_issue" },
                          )
                        }
                      >
                        печать наклеек ({r.line.issued_units.length})
                      </a>
                      {canReturn && r.line.issued_units.map((u) => <AcceptReturnButton key={u.id} unit={u} />)}
                    </Space>
                  ),
              },
            ]}
          />
        </Card>
      )}

      <Modal
        title="Заявка на закупку — с цеха"
        open={shortageModalOpen}
        onCancel={() => setShortageModalOpen(false)}
        footer={null}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          form={shortageForm}
          onFinish={(v) => shopFloorRequestMutation.mutate(v)}
        >
          <Form.Item name="material" label="Материал">
            <Input disabled />
          </Form.Item>
          <Form.Item name="color" label="Цвет">
            <Input disabled />
          </Form.Item>
          <Form.Item name="thickness" label="Толщина, мм">
            <InputNumber disabled style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="requested_area_m2" label="Запросить, м²" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="note" label="Комментарий">
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={shopFloorRequestMutation.isPending}>
            Отправить заявку
          </Button>
        </Form>
      </Modal>
    </div>
  );
}

/** Приём возврата прямо в «Выдано по заданиям» — там же, где плёнку
 * выдавали, а не в отдельной карточке единицы (раздел про единый процесс
 * возврата). Длина остатка по расчёту (хорошие и брак за смену уже
 * учтены) прописывается автоматически — вводить/поправлять число негде.
 * Диалог сразу же предлагает место по правилу зонирования (если оно
 * есть) и позволяет указать полку вручную — приём и размещение одним
 * действием, а не отдельным походом на «Стеллажи → Без места». */
function AcceptReturnButton({ unit }: { unit: ProductionTaskLineIssuedUnit }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" type="primary" onClick={() => setOpen(true)}>
        Принять №{unit.id}
      </Button>
      {open && <AcceptReturnModal unit={unit} onClose={() => setOpen(false)} />}
    </>
  );
}

function AcceptReturnModal({ unit, onClose }: { unit: ProductionTaskLineIssuedUnit; onClose: () => void }) {
  const qc = useQueryClient();
  const [locationCode, setLocationCode] = useState("");
  const [locationTouched, setLocationTouched] = useState(false);

  const previewQuery = useQuery({ queryKey: ["return-preview", unit.id], queryFn: () => getReturnPreview(unit.id) });
  const suggestionQuery = useQuery({
    queryKey: ["suggest-location", "accept-return", unit.id],
    queryFn: () => suggestLocation({ material_sku_id: unit.material_sku_id, is_strip: unit.is_strip }),
  });

  useEffect(() => {
    if (suggestionQuery.data && !locationTouched) setLocationCode(suggestionQuery.data);
  }, [suggestionQuery.data, locationTouched]);

  const expected = previewQuery.data?.expected_return_length_m;

  const acceptMutation = useMutation({
    mutationFn: async () => {
      const returned = await returnUnit(unit.id, { actual_length_m: expected ?? unit.length_m });
      if (locationCode.trim()) await placeUnit(returned.id, locationCode.trim());
      return { returned, placed: !!locationCode.trim() };
    },
    onSuccess: ({ returned, placed }) => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["units-unplaced"] });
      qc.invalidateQueries({ queryKey: ["rack-occupancy"] });
      message.success(
        <>
          №{returned.id} принят{placed ? ` и размещён: ${locationCode.trim()}` : ""} —{" "}
          <a onClick={() => printLabel(returned.id, { kind: "cutting_issue" })}>печать бирки</a>
        </>,
      );
      onClose();
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось принять возврат")),
  });

  return (
    <Modal title={`Принять №${unit.id} на склад`} open onCancel={onClose} footer={null} destroyOnHidden>
      {expected != null ? (
        <Alert
          style={{ marginBottom: 16 }}
          type="info"
          showIcon
          message={`Остаток по расчёту: ${expected} м (хорошие и брак уже учтены) — впишется автоматически.`}
        />
      ) : (
        !previewQuery.isLoading && (
          <Alert
            style={{ marginBottom: 16 }}
            type="warning"
            showIcon
            message="Расчёт остатка недоступен — вернётся как есть, без изменения длины."
          />
        )
      )}

      {suggestionQuery.isLoading ? null : suggestionQuery.data ? (
        <Alert style={{ marginBottom: 8 }} type="success" showIcon message={`По правилу зонирования подходит: ${suggestionQuery.data}`} />
      ) : (
        <Alert style={{ marginBottom: 8 }} type="warning" showIcon message="Нет подходящего правила зонирования — укажите полку вручную" />
      )}
      <Typography.Text strong>Куда поместить остаток (необязательно)</Typography.Text>
      <Input
        style={{ marginTop: 8, marginBottom: 16 }}
        placeholder="Например, Ш-1-04 — оставьте пустым, если пока не знаете"
        value={locationCode}
        onChange={(e) => {
          setLocationTouched(true);
          setLocationCode(e.target.value);
        }}
      />

      <Button type="primary" block loading={acceptMutation.isPending} onClick={() => acceptMutation.mutate()}>
        {locationCode.trim() ? "Принять и разместить" : "Принять без места"}
      </Button>
      <Button block style={{ marginTop: 8 }} onClick={onClose}>
        Отмена
      </Button>
    </Modal>
  );
}
