import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Col,
  Collapse,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Table,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";
import { isAxiosError } from "axios";
import dayjs from "dayjs";
import {
  issueDonorAtomic,
  issueUnit,
  issueUnitDirect,
  placeUnit,
  printLabel,
  searchUnits,
  skuLabel,
  type AreaValue,
  type IssueResult,
  type MaterialSku,
  type MaterialUnit,
} from "../../api/units";
import { suggestLocation } from "../../api/storage";
import { listMaterialSkus } from "../../api/dictionaries";
import {
  listProductionTasks,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineAssignment,
} from "../../api/production";

const areaLabels: Record<string, string> = {
  okutka_tsargovykh: "Окутка царговых",
  shchitovye_dveri: "Щитовые двери",
  tselnolistovye_dveri: "Цельнолистовые двери",
};

const areaOptions: { value: AreaValue; label: string }[] = [
  { value: "okutka_tsargovykh", label: "Окутка царговых" },
  { value: "shchitovye_dveri", label: "Щитовые двери" },
  { value: "tselnolistovye_dveri", label: "Цельнолистовые двери" },
];

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

interface IssuedResult {
  unit: MaterialUnit;
  remainder: MaterialUnit | null;
  remainderPlaced: boolean;
}

export default function Issue() {
  const location = useLocation();
  const qc = useQueryClient();
  const prefill = (location.state as IssuePrefill | null) ?? undefined;

  const [selected, setSelected] = useState<QueueSelection | null>(null);
  const [areaFilter, setAreaFilter] = useState<AreaValue | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<IssueResult | null>(null);
  const [lastIssued, setLastIssued] = useState<IssuedResult | null>(null);

  const [manualSkuId, setManualSkuId] = useState<number | null>(null);
  const [manualArea, setManualArea] = useState<AreaValue | null>(null);
  const [manualForm] = Form.useForm<{ width_mm: number; length_m: number }>();

  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus });
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });

  // --- Очередь: "запрошено сегодня/просрочено" (из распределения по дням)
  // и "задания недели" (остаток по строкам, для которых на сегодня ничего
  // не распределено) — раздел про экран выдачи: складу нужны
  // производственные задания, а не заказы покупателей.
  const today = dayjs().format("YYYY-MM-DD");

  const activeLines = useMemo(
    () =>
      (tasksQuery.data ?? []).flatMap((task) =>
        task.lines.filter((line) => line.remaining_pieces > 0).map((line) => ({ task, line })),
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

  const findMutation = useMutation({
    mutationFn: () =>
      issueUnit({
        material: selectedSku!.material.name,
        color: selectedSku!.color.name,
        thickness: selectedSku!.thickness.value_mm,
        manufacturer: selectedSku!.manufacturer.name,
        width_mm: selectedStripWidth,
        length_m: selected!.line.length_m,
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

  const directMutation = useMutation({
    mutationFn: (unitId: number) => issueUnitDirect(unitId, selected!.task.area, undefined, selected!.line.id),
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
        width_mm: lastIssued!.remainder!.width_mm,
        parent_id: lastIssued!.remainder!.parent_id,
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
            {r.task.product_model_name ?? r.task.name ?? `Задание №${r.task.id}`} · {areaLabels[r.task.area]}
            {r.assignment ? ` · ${r.assignment.line_name} · ${r.assignment.employee_names}` : ""}
          </div>
          <Space size={4} style={{ marginTop: 4 }}>
            <Tag color="blue">штрипс {sw} мм</Tag>
            <Tag>{r.line.material}, {r.line.color}, {r.line.thickness} мм</Tag>
          </Space>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontWeight: 700 }}>
            {r.assignment ? `${r.assignment.quantity_pieces} шт` : `${r.line.remaining_length_m} м`}
          </div>
          <div style={{ fontSize: 11.5, color: "#8A8C99" }}>
            {r.assignment ? `${r.line.length_m} м на штрипс` : `остаток ${r.line.remaining_pieces} шт`}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div>
      <Typography.Title level={4}>Выдача участку</Typography.Title>

      <Row gutter={12} style={{ marginBottom: 16 }}>
        <Col span={6}>
          <Card size="small">
            <Statistic title="Запрошено сегодня" value={todayCount} valueStyle={{ color: "#C97A2B" }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small" style={overdueCount > 0 ? { background: "#FBEAE7", borderColor: "#E3B5AC" } : undefined}>
            <Statistic title="Просрочено" value={overdueCount} valueStyle={{ color: overdueCount > 0 ? "#B8483C" : undefined }} />
          </Card>
        </Col>
        <Col span={6}>
          <Card size="small">
            <Statistic title="Строк в заданиях недели" value={weekRows.length} />
          </Card>
        </Col>
        <Col span={6}>
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

      <Row gutter={20}>
        <Col span={15}>
          <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography.Title level={5} style={{ margin: 0 }}>🔥 Запрошено сегодня</Typography.Title>
            <Tag>{filteredAssignmentRows.length}</Tag>
          </div>
          {filteredAssignmentRows.length === 0 ? (
            <Typography.Text type="secondary">Ничего не распределено на сегодня по выбранному фильтру.</Typography.Text>
          ) : (
            filteredAssignmentRows.map((r) => queueRow(r, "today"))
          )}

          <div style={{ margin: "20px 0 8px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography.Title level={5} style={{ margin: 0 }}>📋 Задания участка — на неделю</Typography.Title>
            <Tag>{filteredWeekRows.length}</Tag>
          </div>
          {filteredWeekRows.length === 0 ? (
            <Typography.Text type="secondary">Остатка по заданиям, не распределённым на сегодня, нет.</Typography.Text>
          ) : (
            filteredWeekRows.map((r) => queueRow(r, "week"))
          )}
        </Col>

        <Col span={9}>
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
                        {selected.task.product_model_name ?? selected.task.name} · {areaLabels[selected.task.area]}
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
                        <Table<MaterialUnit>
                          size="small"
                          rowKey="id"
                          loading={availableQuery.isLoading}
                          dataSource={availableQuery.data ?? []}
                          pagination={false}
                          locale={{ emptyText: "Ничего нет на хранении" }}
                          columns={[
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
                          <Table<MaterialUnit>
                            size="small"
                            rowKey="id"
                            loading={manualAvailableQuery.isLoading}
                            dataSource={manualAvailableQuery.data ?? []}
                            pagination={false}
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
    </div>
  );
}
