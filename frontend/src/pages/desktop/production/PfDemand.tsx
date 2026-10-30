import { useEffect, useMemo, useState } from "react";
import ShortageTags from "../../../components/ShortageTags";
import { PfFilterBar, PfSections } from "../../../components/PfGrouping";
import { filterPf, sectionsPf, usePfFilter, usePfIndex } from "../../../components/pfGroupingState";
import dayjs, { type Dayjs } from "dayjs";
import { useNavigate } from "react-router-dom";
import {
  DatePicker,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Tag,
  Typography,
  message,
  Segmented,
  Table,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { useAuth } from "../../../auth/AuthContext";
import { listAreas } from "../../../api/areas";
import { listParts } from "../../../api/dictionaries";
import { setNormatives } from "../../../api/items";
import {
  createPfTasks,
  listPfDemand,
  producePfUnits,
  suggestLaminationArea,
  transferPfUnits,
  type PfDemandRow,
} from "../../../api/pfDemand";
import LaminationAreaSelect from "../../../components/LaminationAreaSelect";
import { apiErrorMessage } from "../../../utils/apiError";
import { normsLabel } from "../../../utils/normatives";
import { hasPerm } from "../../../auth/permissions";

const fmt = (n: number) => Math.round(n * 100) / 100;
type Horizon = "all" | "overdue" | "today" | "week";
type FilterStatus = "all" | "shortage" | "ready_transfer" | "in_work";

const matchHorizon = (d: string | null | undefined, h: Horizon): boolean => {
  if (h === "all") return true;
  if (!d) return false;
  const target = dayjs(d).startOf("day");
  const today = dayjs().startOf("day");
  if (h === "overdue") return target.isBefore(today);
  if (h === "today") return !target.isAfter(today);
  if (h === "week") return !target.isAfter(today.add(7, "day"));
  return true;
};

interface TransferTarget {
  part_id: number;
  part_name: string;
  storage_stock: number;
  target_area: string;
  needed: number;
}

interface ProduceTarget {
  part_id: number;
  part_name: string;
  suggested_qty: number;
  target_area: string | null;
  stage_id?: number | null;
}

/** Потребность п/ф — основной рабочий экран мастера по производству п/ф.
 * Отображает потребность цеха, фактические остатки на складе ПФ и на участках-потребителях,
 * позволяет прямо в строке выпустить продукцию или переместить её на участок. */
export default function PfDemand() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = hasPerm(user, "production_tasks.manage");
  const canOperate =
    hasPerm(user, "production_tasks.manage") ||
    hasPerm(user, "part_units.manage") ||
    hasPerm(user, "part_storage.manage");

  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [showAllCatalog, setShowAllCatalog] = useState(false);
  const [onlyMine, setOnlyMine] = useState(!!user?.area);
  const [horizon, setHorizon] = useState<Horizon>(user?.area ? "today" : "all");
  const [viewMode, setViewMode] = useState<"parts" | "tasks">("parts");
  const [qty, setQty] = useState<Record<number, number | null>>({});
  const [dueDate, setDueDate] = useState<Dayjs | null>(null);
  const [lamArea, setLamArea] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [editTarget, setEditTarget] = useState<PfDemandRow | null>(null);
  const [taskFilter, setTaskFilter] = useState<number[]>([]);

  // Модальные окна действий
  const [transferTarget, setTransferTarget] = useState<TransferTarget | null>(null);
  const [produceTarget, setProduceTarget] = useState<ProduceTarget | null>(null);

  const [pf, setPf] = usePfFilter();
  const { byPart: pfAttrs, groups: itemGroups } = usePfIndex();

  const allQuery = useQuery({ queryKey: ["pf-demand", []], queryFn: () => listPfDemand([]) });
  const demandQuery = useQuery({ queryKey: ["pf-demand", taskFilter], queryFn: () => listPfDemand(taskFilter) });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts, enabled: !!user?.area });

  const myParts = useMemo(
    () => new Set((partsQuery.data ?? []).filter((p) => p.stages.some((st) => st.area === user?.area)).map((p) => p.id)),
    [partsQuery.data, user?.area],
  );

  const areaName = (code: string | null | undefined) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : null);

  // Сводные счетчики для панели фильтров
  const stats = useMemo(() => {
    const all = demandQuery.data ?? [];
    const shortageCount = all.filter((r) => r.shortage > 0).length;
    const readyTransferCount = all.filter(
      (r) => (r.storage_stock ?? 0) > 0 && (r.task_demand > (r.area_stock ?? 0) || (r.shortage_tasks ?? 0) > 0),
    ).length;
    const inWorkCount = all.filter((r) => r.in_work > 0).length;
    return { total: all.length, shortageCount, readyTransferCount, inWorkCount };
  }, [demandQuery.data]);

  const rows = useMemo(
    () =>
      filterPf(
        (demandQuery.data ?? [])
          .filter((r) => {
            if (showAllCatalog) return true;
            // По умолчанию видны все позиции с активной потребностью, нехваткой, остатком на складе или в работе
            return (
              r.task_demand > 0 ||
              r.shortage > 0 ||
              (r.storage_stock ?? 0) > 0 ||
              r.in_work > 0 ||
              (r.min_stock ?? 0) > 0
            );
          })
          .filter((r) => {
            if (filterStatus === "all") return true;
            if (filterStatus === "shortage") return r.shortage > 0;
            if (filterStatus === "ready_transfer") {
              const storage = r.storage_stock ?? 0;
              const needOnArea = r.task_demand - (r.area_stock ?? 0);
              return storage > 0 && (needOnArea > 0 || (r.shortage_tasks ?? 0) > 0);
            }
            if (filterStatus === "in_work") return r.in_work > 0;
            return true;
          })
          .filter((r) => !onlyMine || !user?.area || myParts.has(r.part_id))
          .filter((r) => horizon === "all" || r.sources.some((s) => matchHorizon(s.due_date, horizon))),
        (r) => r.part_id,
        pf,
        pfAttrs,
        itemGroups,
      ),
    [demandQuery.data, showAllCatalog, filterStatus, onlyMine, myParts, user?.area, horizon, pf, pfAttrs, itemGroups],
  );

  const sections = sectionsPf(rows, (r) => r.part_id, pf, pfAttrs, itemGroups);

  const taskStats = useMemo(() => {
    const base = filterPf(
      (allQuery.data ?? [])
        .filter((r) => !onlyMine || !user?.area || myParts.has(r.part_id))
        .filter((r) => horizon === "all" || r.sources.some((s) => matchHorizon(s.due_date, horizon))),
      (r) => r.part_id,
      pf,
      pfAttrs,
      itemGroups,
    );
    const by = new Map<number, { id: number; name: string; dueDate?: string | null; area?: string | null; parts: number; shortage: number }>();
    for (const r of base)
      for (const src of r.sources) {
        if (horizon !== "all" && !matchHorizon(src.due_date, horizon)) continue;
        const t = by.get(src.task_id) ?? { id: src.task_id, name: src.task_name, dueDate: src.due_date, area: src.area, parts: 0, shortage: 0 };
        t.parts += 1;
        t.shortage += src.shortage;
        by.set(src.task_id, t);
      }
    return [...by.values()].sort((a, b) => b.shortage - a.shortage || b.parts - a.parts || a.id - b.id);
  }, [allQuery.data, onlyMine, user?.area, myParts, horizon, pf, pfAttrs, itemGroups]);

  interface TaskSourceItem {
    partId: number;
    partName: string;
    openPlan: number;
    done: number;
    remaining: number;
    reserveSet: number;
    reserved: number;
    inWork: number;
    shortage: number;
    stock: number;
    storageStock: number;
    areaStock: number;
    free: number;
    suggested: number;
    firstStageArea: string | null;
    firstStageName: string;
    itemId?: number | null;
    targetAreas?: string[];
  }

  interface TaskCardData {
    taskId: number;
    taskName: string;
    dueDate: string | null;
    area: string | null;
    sources: TaskSourceItem[];
    totalRemaining: number;
    totalShortage: number;
    totalReserved: number;
    totalInWork: number;
  }

  const tasksList = useMemo(() => {
    const map = new Map<number, TaskCardData>();
    for (const r of rows) {
      for (const src of r.sources) {
        if (horizon !== "all" && !matchHorizon(src.due_date, horizon)) continue;
        if (taskFilter.length > 0 && !taskFilter.includes(src.task_id)) continue;

        let t = map.get(src.task_id);
        if (!t) {
          t = {
            taskId: src.task_id,
            taskName: src.task_name,
            dueDate: src.due_date ?? null,
            area: src.area ?? null,
            sources: [],
            totalRemaining: 0,
            totalShortage: 0,
            totalReserved: 0,
            totalInWork: 0,
          };
          map.set(src.task_id, t);
        }
        t.sources.push({
          partId: r.part_id,
          partName: r.part_name,
          openPlan: src.open_plan,
          done: src.done,
          remaining: src.remaining,
          reserveSet: src.reserve_set,
          reserved: src.reserved,
          inWork: src.in_work,
          shortage: src.shortage,
          stock: r.stock,
          storageStock: r.storage_stock ?? 0,
          areaStock: src.area_stock ?? 0,
          free: r.free,
          suggested: r.suggested,
          firstStageArea: r.first_stage_area,
          firstStageName: r.first_stage_name,
          itemId: r.item_id,
          targetAreas: r.target_areas,
        });
        t.totalRemaining += src.remaining;
        t.totalShortage += src.shortage;
        t.totalReserved += src.reserved;
        t.totalInWork += src.in_work;
      }
    }

    return [...map.values()].sort((a, b) => {
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;
      return b.totalShortage - a.totalShortage || a.taskId - b.taskId;
    });
  }, [rows, horizon, taskFilter]);

  const TOP = 8;
  const topTasks = taskStats.slice(0, TOP);
  const taskOptions = taskStats.map((t) => ({
    value: t.id,
    label: `№${t.id} · ${t.name} — деталей ${t.parts}${t.shortage > 0 ? `, не хватает ${fmt(t.shortage)}` : ""}`,
  }));
  const toggleTask = (id: number) => setTaskFilter((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));

  useEffect(() => {
    const data = demandQuery.data ?? [];
    setQty(Object.fromEntries(data.map((r) => [r.part_id, r.suggested || null])));
    setSelected(data.filter((r) => r.suggested > 0 && r.first_stage_area).map((r) => r.part_id));
  }, [demandQuery.data]);

  const createMutation = useMutation({
    mutationFn: () =>
      createPfTasks({
        ship_date: dueDate ? dueDate.format("YYYY-MM-DD") : null,
        items: toCreate.map((id) => {
          const row = (demandQuery.data ?? []).find((r) => r.part_id === id);
          const area = lamArea[id] ?? (row ? suggestLaminationArea(row, qty[id]) : undefined);
          return { part_id: id, quantity_pieces: qty[id] as number, lamination_area: area ?? null };
        }),
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["pf-demand"] });
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success(
        <span>
          Создано заданий: {res.task_ids.length}. <a onClick={() => navigate("/production-tasks")}>Открыть задания цеха</a>
        </span>,
      );
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать задания")),
  });

  const visible = new Set(rows.map((r) => r.part_id));
  const toCreate = selected.filter((id) => visible.has(id) && (qty[id] ?? 0) > 0);

  return (
    <Space orientation="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Рабочий экран мастера ПФ: потребность, остатки и выпуск"
        extra={
          canManage && (
            <Button
              type="primary"
              disabled={toCreate.length === 0 || !dueDate}
              loading={createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              Создать задания ({toCreate.length})
            </Button>
          )
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Экран мастера полуфабрикатов: потребности участков цеха, наличие на складе ПФ и на целевых участках.
          Нажимайте <b>«Переместить»</b> для передачи готовых деталей в цех или <b>«Выпустить»</b> для быстрого оприходования партии.
        </Typography.Paragraph>

        {/* Верхняя строка режимов и горизонтов */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
          <Space wrap size={[12, 12]}>
            <Segmented<FilterStatus>
              value={filterStatus}
              onChange={setFilterStatus}
              options={[
                { label: `Все с потребностью (${stats.total})`, value: "all" },
                { label: `🚨 К выпуску (${stats.shortageCount})`, value: "shortage" },
                { label: `🚚 К перемещению (${stats.readyTransferCount})`, value: "ready_transfer" },
                { label: `⚙️ В работе (${stats.inWorkCount})`, value: "in_work" },
              ]}
            />
            <Segmented<Horizon>
              value={horizon}
              onChange={setHorizon}
              options={[
                { label: "Все сроки", value: "all" },
                { label: "🚨 Отстают", value: "overdue" },
                { label: "📅 На сегодня", value: "today" },
                { label: "📆 На неделю", value: "week" },
              ]}
            />
            <Segmented<"parts" | "tasks">
              value={viewMode}
              onChange={setViewMode}
              options={[
                { label: "📋 По деталям", value: "parts" },
                { label: "📑 По заданиям", value: "tasks" },
              ]}
            />
          </Space>
          {viewMode === "tasks" && (
            <Typography.Text type="secondary">
              Заданий: <b>{tasksList.length}</b>
              {tasksList.filter((t) => t.totalShortage > 0).length > 0 && (
                <> · с нехваткой: <b style={{ color: "#cf1322" }}>{tasksList.filter((t) => t.totalShortage > 0).length}</b></>
              )}
            </Typography.Text>
          )}
        </div>

        {/* Нижняя строка отборов */}
        <Space wrap size={[12, 12]}>
          <Select
            mode="multiple"
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ minWidth: 320 }}
            placeholder={taskStats.length > TOP ? `ещё ${taskStats.length - TOP} заданий…` : "Задание…"}
            options={taskOptions}
            value={taskFilter}
            onChange={setTaskFilter}
            loading={allQuery.isLoading}
          />
          {canManage && (
            <DatePicker
              value={dueDate}
              onChange={setDueDate}
              format="DD.MM.YYYY"
              placeholder="Срок для новых заданий"
              disabledDate={(d) => d.isBefore(dayjs(), "day")}
              status={toCreate.length > 0 && !dueDate ? "warning" : undefined}
            />
          )}
          <Checkbox checked={showAllCatalog} onChange={(e) => setShowAllCatalog(e.target.checked)}>
            Весь справочник
          </Checkbox>
          {user?.area && (
            <Checkbox checked={onlyMine} onChange={(e) => setOnlyMine(e.target.checked)}>
              Мой участок: {areaName(user.area)}
            </Checkbox>
          )}
          <PfFilterBar value={pf} onChange={setPf} groups={itemGroups} />
        </Space>

        {topTasks.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Typography.Text type="secondary" style={{ marginRight: 8 }}>
              {onlyMine && user?.area ? "Задания, которым нужны детали вашего участка:" : "Задания цеха:"}
            </Typography.Text>
            <Space wrap size={[6, 6]}>
              <Tag.CheckableTag checked={taskFilter.length === 0} onChange={() => setTaskFilter([])} style={{ fontSize: 13, padding: "3px 10px" }}>
                Все ({taskStats.length})
              </Tag.CheckableTag>
              {topTasks.map((t) => (
                <Tag.CheckableTag
                  key={t.id}
                  checked={taskFilter.includes(t.id)}
                  onChange={() => toggleTask(t.id)}
                  style={{ fontSize: 13, padding: "3px 10px", border: "1px solid #E4E4DF" }}
                >
                  №{t.id} {t.name.length > 28 ? t.name.slice(0, 27) + "…" : t.name}
                  {t.shortage > 0 && <b style={{ color: taskFilter.includes(t.id) ? undefined : "#C0392B" }}> −{fmt(t.shortage)}</b>}
                </Tag.CheckableTag>
              ))}
            </Space>
          </div>
        )}
      </Card>

      {viewMode === "tasks" ? (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {tasksList.length === 0 ? (
            <Card style={{ textAlign: "center", padding: 32 }}>
              <Typography.Text type="secondary">Нет подходящих заданий</Typography.Text>
            </Card>
          ) : (
            tasksList.map((t) => {
              const isOverdue = t.dueDate && dayjs(t.dueDate).isBefore(dayjs(), "day");
              const isToday = t.dueDate && dayjs(t.dueDate).isSame(dayjs(), "day");
              return (
                <Card
                  key={t.taskId}
                  size="small"
                  styles={{
                    header: {
                      background: isOverdue ? "#fff1f0" : isToday ? "#fffbe6" : "#fafafa",
                      borderBottom: isOverdue ? "1px solid #ffa39e" : isToday ? "1px solid #ffe58f" : undefined,
                    },
                  }}
                  title={
                    <Space wrap align="center">
                      <span style={{ fontWeight: 600, fontSize: 15 }}>
                        №{t.taskId} · {t.taskName}
                      </span>
                      {t.dueDate ? (
                        isOverdue ? (
                          <Tag color="error" style={{ fontWeight: 600 }}>🚨 Отстаёт ({dayjs(t.dueDate).format("DD.MM.YYYY")})</Tag>
                        ) : isToday ? (
                          <Tag color="warning" style={{ fontWeight: 600 }}>📅 Срок сегодня</Tag>
                        ) : (
                          <Tag color="processing">📆 Срок {dayjs(t.dueDate).format("DD.MM.YYYY")}</Tag>
                        )
                      ) : (
                        <Tag>Срок не указан</Tag>
                      )}
                      {t.area && <Tag color="cyan">{areaName(t.area)}</Tag>}
                      {t.totalShortage > 0 ? (
                        <Tag color="red" style={{ fontWeight: 600 }}>
                          Не хватает: {fmt(t.totalShortage)} шт
                        </Tag>
                      ) : (
                        <Tag color="green">П/ф обеспечены ({fmt(t.totalReserved)} рез. / {fmt(t.totalInWork)} в раб.)</Tag>
                      )}
                    </Space>
                  }
                  extra={
                    canManage && t.totalShortage > 0 && (
                      <Button
                        size="small"
                        type="link"
                        onClick={() => {
                          const shortPartIds = t.sources.filter((s) => s.shortage > 0).map((s) => s.partId);
                          setSelected((prev) => Array.from(new Set([...prev, ...shortPartIds])));
                          message.info(`Детали задания №${t.taskId} выбраны для запуска`);
                        }}
                      >
                        Выбрать детали задания ({t.sources.filter((s) => s.shortage > 0).length})
                      </Button>
                    )
                  }
                >
                  <Table
                    size="small"
                    rowKey="partId"
                    dataSource={t.sources}
                    pagination={false}
                    columns={[
                      {
                        title: "Деталь",
                        dataIndex: "partName",
                        render: (name, s) => (
                          <Space orientation="vertical" size={0}>
                            <span style={{ fontWeight: 500 }}>{name}</span>
                            {s.firstStageArea && (
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {areaName(s.firstStageArea)} · {s.firstStageName}
                              </Typography.Text>
                            )}
                          </Space>
                        ),
                      },
                      {
                        title: "План",
                        render: (_, s) => fmt(s.openPlan),
                        align: "right",
                      },
                      {
                        title: "Сделано",
                        render: (_, s) => fmt(s.done),
                        align: "right",
                      },
                      {
                        title: "Остаток",
                        render: (_, s) => <b>{fmt(s.remaining)}</b>,
                        align: "right",
                      },
                      {
                        title: "На участке",
                        render: (_, s) => (
                          <span style={{ color: s.areaStock > 0 ? "#1890ff" : "#8c8c8c", fontWeight: s.areaStock > 0 ? 600 : 400 }}>
                            {fmt(s.areaStock)}
                          </span>
                        ),
                        align: "right",
                      },
                      {
                        title: "На складе ПФ",
                        render: (_, s) => (
                          <span style={{ color: s.storageStock > 0 ? "#52c41a" : "#8c8c8c", fontWeight: s.storageStock > 0 ? 600 : 400 }}>
                            {fmt(s.storageStock)}
                          </span>
                        ),
                        align: "right",
                      },
                      {
                        title: "Обеспечено",
                        render: (_, s) => (
                          <span>
                            {s.reserved > 0 && <Tag color="blue">{fmt(s.reserved)} рез.</Tag>}
                            {s.inWork > 0 && <Tag color="geekblue">{fmt(s.inWork)} в работе</Tag>}
                            {s.reserved === 0 && s.inWork === 0 && "—"}
                          </span>
                        ),
                      },
                      {
                        title: "Не хватает",
                        render: (_, s) =>
                          s.shortage > 0 ? (
                            <Tag color="red" style={{ fontWeight: 600 }}>−{fmt(s.shortage)} шт</Tag>
                          ) : (
                            <Tag color="green">обеспечено</Tag>
                          ),
                        align: "right",
                      },
                      {
                        title: "Действия мастера",
                        render: (_, s) => {
                          const canTransfer = s.storageStock > 0 && t.area;
                          const needToMove = Math.max(0, s.remaining - s.areaStock);
                          return (
                            <Space size={6} wrap>
                              {canTransfer && (
                                <Button
                                  size="small"
                                  type="primary"
                                  ghost
                                  style={{ borderColor: "#13c2c2", color: "#13c2c2" }}
                                  disabled={!canOperate}
                                  onClick={() =>
                                    setTransferTarget({
                                      part_id: s.partId,
                                      part_name: s.partName,
                                      storage_stock: s.storageStock,
                                      target_area: t.area || "",
                                      needed: needToMove > 0 ? needToMove : s.storageStock,
                                    })
                                  }
                                >
                                  🚚 Передать
                                </Button>
                              )}
                              <Button
                                size="small"
                                disabled={!canOperate}
                                onClick={() =>
                                  setProduceTarget({
                                    part_id: s.partId,
                                    part_name: s.partName,
                                    suggested_qty: s.shortage > 0 ? s.shortage : s.remaining,
                                    target_area: t.area || null,
                                    stage_id: null,
                                  })
                                }
                              >
                                🏭 Выпустить
                              </Button>
                            </Space>
                          );
                        },
                      },
                    ]}
                  />
                </Card>
              );
            })
          )}
        </Space>
      ) : (
        <PfSections
          sections={sections}
          total={(rs) => `не хватает ${fmt(rs.reduce((s, r) => s + r.shortage, 0))}`}
          render={(sectionRows, key) => (
            <ResponsiveTable<PfDemandRow>
              key={key}
              tableKey="pf-demand"
              lockedColumns={["Деталь"]}
              size="small"
              rowKey="part_id"
              loading={demandQuery.isLoading}
              dataSource={sectionRows}
              pagination={{ pageSize: 50, hideOnSinglePage: true }}
              scroll={{ x: "max-content" }}
              locale={{ emptyText: "Нет подходящих деталей" }}
              expandable={{
                rowExpandable: (r) => r.sources.length > 0,
                expandedRowRender: (r) => (
                  <div style={{ padding: "4px 0" }}>
                    <Typography.Text type="secondary">
                      Потребность по заданиям цеха: сделанное сверх плана одной строки закрывает соседние.
                    </Typography.Text>
                    <table style={{ marginTop: 8, borderCollapse: "collapse", width: "100%" }}>
                      <thead>
                        <tr>
                          {["Задание цеха", "Срок", "Куда требуется", "На участке", "План", "Сделано", "Остаток", "Резерв", "В работе", "Не хватает", "Действие"].map((h) => (
                            <th key={h} style={{ textAlign: "left", padding: "4px 12px 4px 0", fontWeight: 500 }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {r.sources.map((s) => {
                          const isOverdue = s.due_date && dayjs(s.due_date).isBefore(dayjs(), "day");
                          const isToday = s.due_date && dayjs(s.due_date).isSame(dayjs(), "day");
                          const canMoveToSource = (r.storage_stock ?? 0) > 0 && s.area;
                          const needToMove = Math.max(0, s.remaining - (s.area_stock ?? 0));
                          return (
                            <tr key={s.task_id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                              <td style={{ padding: "4px 12px 4px 0" }}>
                                №{s.task_id} · {s.task_name}
                              </td>
                              <td style={{ padding: "4px 12px 4px 0" }}>
                                {s.due_date ? (
                                  isOverdue ? (
                                    <Tag color="error">🚨 {dayjs(s.due_date).format("DD.MM.YYYY")}</Tag>
                                  ) : isToday ? (
                                    <Tag color="warning">📅 Сегодня</Tag>
                                  ) : (
                                    <Tag color="processing">📆 {dayjs(s.due_date).format("DD.MM.YYYY")}</Tag>
                                  )
                                ) : (
                                  <span style={{ color: "#8c8c8c" }}>—</span>
                                )}
                              </td>
                              <td style={{ padding: "4px 12px 4px 0" }}>
                                {areaName(s.area) ? <Tag color="blue">{areaName(s.area)}</Tag> : "—"}
                              </td>
                              <td style={{ padding: "4px 12px 4px 0", color: (s.area_stock ?? 0) > 0 ? "#1890ff" : "#8c8c8c", fontWeight: (s.area_stock ?? 0) > 0 ? 600 : 400 }}>
                                {fmt(s.area_stock ?? 0)}
                              </td>
                              <td style={{ padding: "4px 12px 4px 0" }}>{fmt(s.open_plan)}</td>
                              <td style={{ padding: "4px 12px 4px 0" }}>{fmt(s.done)}</td>
                              <td style={{ padding: "4px 12px 4px 0" }}>
                                <b>{fmt(s.remaining)}</b>
                              </td>
                              <td style={{ padding: "4px 12px 4px 0" }}>{s.reserved > 0 ? fmt(s.reserved) : "—"}</td>
                              <td style={{ padding: "4px 12px 4px 0" }}>{s.in_work > 0 ? fmt(s.in_work) : "—"}</td>
                              <td style={{ padding: "4px 12px 4px 0" }}>
                                {s.shortage > 0 ? <Tag color="red">−{fmt(s.shortage)}</Tag> : <Tag color="green">обеспечено</Tag>}
                              </td>
                              <td style={{ padding: "4px 12px 4px 0" }}>
                                {canMoveToSource && (
                                  <Button
                                    size="small"
                                    type="link"
                                    disabled={!canOperate}
                                    onClick={() =>
                                      setTransferTarget({
                                        part_id: r.part_id,
                                        part_name: r.part_name,
                                        storage_stock: r.storage_stock ?? 0,
                                        target_area: s.area || "",
                                        needed: needToMove > 0 ? needToMove : (r.storage_stock ?? 0),
                                      })
                                    }
                                  >
                                    🚚 Передать
                                  </Button>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ),
              }}
              rowSelection={
                canManage
                  ? {
                      selectedRowKeys: selected,
                      onChange: (keys) =>
                        setSelected((prev) => [
                          ...prev.filter((id) => !sectionRows.some((r) => r.part_id === id)),
                          ...(keys as number[]),
                        ]),
                      getCheckboxProps: (r) => ({ disabled: !r.first_stage_area }),
                    }
                  : undefined
              }
              columns={[
                {
                  title: "Деталь",
                  dataIndex: "part_name",
                  render: (name, r) => (
                    <Space orientation="vertical" size={2}>
                      <span style={{ fontWeight: 600 }}>{name}</span>
                      {r.target_areas && r.target_areas.length > 0 && (
                        <Space wrap size={4}>
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>Куда:</Typography.Text>
                          {r.target_areas.map((a) => (
                            <Tag key={a} color="blue" style={{ fontSize: 11, padding: "0 5px", margin: 0 }}>
                              {areaName(a)}
                            </Tag>
                          ))}
                        </Space>
                      )}
                    </Space>
                  ),
                },
                {
                  title: "Нормативы",
                  render: (_, r) => (
                    <Space size={4}>
                      <span>{normsLabel(r.min_stock, r.min_batch, r.batch_multiple)}</span>
                      {canManage && r.item_id != null && (
                        <Button size="small" type="link" onClick={() => setEditTarget(r)}>
                          изменить
                        </Button>
                      )}
                    </Space>
                  ),
                },
                {
                  title: "Потребность цеха",
                  render: (_, r) => <b>{fmt(r.task_demand)}</b>,
                  align: "right",
                },
                {
                  title: "На участке цеха",
                  render: (_, r) => {
                    const areaSt = r.area_stock ?? 0;
                    return (
                      <span style={{ color: areaSt > 0 ? "#1890ff" : "#8c8c8c", fontWeight: areaSt > 0 ? 600 : 400 }}>
                        {fmt(areaSt)}
                      </span>
                    );
                  },
                  align: "right",
                },
                {
                  title: "На складе ПФ (у меня)",
                  render: (_, r) => {
                    const storage = r.storage_stock ?? 0;
                    return (
                      <span style={{ color: storage > 0 ? "#52c41a" : "#8c8c8c", fontWeight: storage > 0 ? 700 : 400, fontSize: storage > 0 ? 14 : undefined }}>
                        {fmt(storage)}
                      </span>
                    );
                  },
                  align: "right",
                },
                {
                  title: "В резерве / свободно",
                  render: (_, r) => (
                    <span>
                      {fmt(r.reserved)} / <b>{fmt(r.free)}</b>
                    </span>
                  ),
                  align: "right",
                },
                {
                  title: "В работе",
                  render: (_, r) => fmt(r.in_work),
                  align: "right",
                },
                {
                  title: "Не хватает",
                  render: (_, r) => <ShortageTags total={r.shortage} tasks={r.shortage_tasks} min={r.shortage_min} />,
                  align: "right",
                },
                {
                  title: "Статус",
                  render: (_, r) => {
                    const storage = r.storage_stock ?? 0;
                    const needOnArea = r.task_demand - (r.area_stock ?? 0);
                    if (storage > 0 && (needOnArea > 0 || (r.shortage_tasks ?? 0) > 0)) {
                      return (
                        <Tag color="cyan" style={{ fontWeight: 600 }}>
                          🚚 Готово к передаче ({Math.min(storage, Math.max(1, needOnArea))} шт)
                        </Tag>
                      );
                    }
                    if (r.shortage > 0) {
                      return (
                        <Tag color="error" style={{ fontWeight: 600 }}>
                          🚨 К выпуску ({fmt(r.shortage)} шт)
                        </Tag>
                      );
                    }
                    if (r.task_demand > 0 && (r.area_stock ?? 0) >= r.task_demand) {
                      return <Tag color="success">✅ На участке</Tag>;
                    }
                    if (r.in_work > 0) {
                      return <Tag color="geekblue">⚙️ В работе ({fmt(r.in_work)} шт)</Tag>;
                    }
                    return <Tag color="default">В норме</Tag>;
                  },
                },
                {
                  title: "Действия мастера",
                  key: "master_actions",
                  render: (_, r) => {
                    const storage = r.storage_stock ?? 0;
                    const defaultTargetArea = r.target_areas?.[0] ?? "";
                    const needOnArea = Math.max(0, r.task_demand - (r.area_stock ?? 0));
                    return (
                      <Space size={6} wrap>
                        {storage > 0 && (
                          <Button
                            size="small"
                            type="primary"
                            ghost
                            style={{ borderColor: "#13c2c2", color: "#13c2c2" }}
                            disabled={!canOperate}
                            onClick={() =>
                              setTransferTarget({
                                part_id: r.part_id,
                                part_name: r.part_name,
                                storage_stock: storage,
                                target_area: defaultTargetArea,
                                needed: needOnArea > 0 ? needOnArea : storage,
                              })
                            }
                          >
                            🚚 Переместить
                          </Button>
                        )}
                        <Button
                          size="small"
                          type="primary"
                          disabled={!canOperate}
                          onClick={() =>
                            setProduceTarget({
                              part_id: r.part_id,
                              part_name: r.part_name,
                              suggested_qty: r.suggested > 0 ? r.suggested : (r.shortage > 0 ? r.shortage : (r.min_batch || 100)),
                              target_area: defaultTargetArea || null,
                              stage_id: r.first_stage_id,
                            })
                          }
                        >
                          🏭 Выпустить
                        </Button>
                      </Space>
                    );
                  },
                },
                ...(canManage
                  ? [
                      {
                        title: "К заданию, шт",
                        render: (_: any, r: PfDemandRow) => (
                          <InputNumber
                            min={0}
                            size="small"
                            style={{ width: 90 }}
                            value={qty[r.part_id] ?? null}
                            onChange={(v) => setQty((prev) => ({ ...prev, [r.part_id]: v }))}
                          />
                        ),
                      },
                      {
                        title: "Ламинация",
                        render: (_: any, r: PfDemandRow) => (
                          <LaminationAreaSelect
                            row={r}
                            disabled={!canManage}
                            areaName={areaName}
                            value={lamArea[r.part_id] ?? suggestLaminationArea(r, qty[r.part_id])}
                            onChange={(v) => setLamArea((prev) => ({ ...prev, [r.part_id]: v }))}
                          />
                        ),
                      },
                      {
                        title: "Маршрут",
                        render: (_: any, r: PfDemandRow) =>
                          r.first_stage_area ? (
                            <span>
                              {areaName(r.first_stage_area)} · <Typography.Text type="secondary">{r.first_stage_name}</Typography.Text>
                            </span>
                          ) : (
                            <Tag color="orange">не указан</Tag>
                          ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        />
      )}

      {/* Модальное окно перемещения на участок */}
      {transferTarget && (
        <TransferModal
          target={transferTarget}
          areas={areasQuery.data ?? []}
          areaName={areaName}
          onClose={() => setTransferTarget(null)}
        />
      )}

      {/* Модальное окно выпуска продукции */}
      {produceTarget && (
        <ProduceModal
          target={produceTarget}
          areas={areasQuery.data ?? []}
          areaName={areaName}
          onClose={() => setProduceTarget(null)}
        />
      )}

      {editTarget && <MinValuesModal row={editTarget} onClose={() => setEditTarget(null)} />}
    </Space>
  );
}

/** Модальное окно перемещения партии на участок цеха */
function TransferModal({
  target,
  areas,
  onClose,
  areaName,
}: {
  target: TransferTarget;
  areas: { code: string; name: string }[];
  onClose: () => void;
  areaName: (code: string | null | undefined) => string | null;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ target_area: string; quantity_pieces: number; note?: string }>();

  const mutation = useMutation({
    mutationFn: (vals: { target_area: string; quantity_pieces: number; note?: string }) =>
      transferPfUnits({
        part_id: target.part_id,
        target_area: vals.target_area,
        quantity_pieces: vals.quantity_pieces,
        note: vals.note,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["pf-demand"] });
      qc.invalidateQueries({ queryKey: ["part-units"] });
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success(`Перемещено ${res.transferred_pieces} шт на участок «${areaName(res.target_area)}»`);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Ошибка перемещения")),
  });

  const defaultQty = Math.min(
    target.storage_stock,
    target.needed > 0 ? target.needed : target.storage_stock,
  );

  return (
    <Modal
      title={
        <Space>
          <span>🚚 Перемещение на участок:</span>
          <b>{target.part_name}</b>
        </Space>
      }
      open
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      <div style={{ marginBottom: 16, padding: "8px 12px", background: "#f6ffed", border: "1px solid #b7eb8f", borderRadius: 6 }}>
        <Typography.Text>
          Доступно на складе ПФ: <b style={{ color: "#389e0d" }}>{fmt(target.storage_stock)} шт</b>
          {target.needed > 0 && (
            <> · Потребность участка: <b>{fmt(target.needed)} шт</b></>
          )}
        </Typography.Text>
      </div>
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          target_area: target.target_area || (areas[0]?.code ?? ""),
          quantity_pieces: defaultQty > 0 ? defaultQty : 1,
        }}
        onFinish={(vals) => mutation.mutate(vals)}
      >
        <Form.Item
          name="target_area"
          label="Куда переместить (целевой участок)"
          rules={[{ required: true, message: "Выберите участок" }]}
        >
          <Select
            options={areas.map((a) => ({ value: a.code, label: a.name }))}
            placeholder="Выберите участок"
          />
        </Form.Item>
        <Form.Item
          name="quantity_pieces"
          label="Количество, шт"
          rules={[
            { required: true, message: "Укажите количество" },
            { type: "number", min: 1, max: target.storage_stock, message: `От 1 до ${target.storage_stock} шт` },
          ]}
        >
          <InputNumber min={1} max={target.storage_stock} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="note" label="Примечание (опционально)">
          <Input.TextArea rows={2} placeholder="Например: выдача под текущую смену" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending} style={{ height: 40, marginTop: 8 }}>
          Переместить на участок
        </Button>
      </Form>
    </Modal>
  );
}

/** Модальное окно быстрого выпуска продукции мастером ПФ */
function ProduceModal({
  target,
  areas,
  onClose,
  areaName,
}: {
  target: ProduceTarget;
  areas: { code: string; name: string }[];
  onClose: () => void;
  areaName: (code: string | null | undefined) => string | null;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{
    quantity_pieces: number;
    auto_transfer: boolean;
    transfer_to_area?: string;
    note?: string;
  }>();
  const autoTransfer = Form.useWatch("auto_transfer", form);

  const mutation = useMutation({
    mutationFn: (vals: {
      quantity_pieces: number;
      auto_transfer: boolean;
      transfer_to_area?: string;
      note?: string;
    }) =>
      producePfUnits({
        part_id: target.part_id,
        quantity_pieces: vals.quantity_pieces,
        stage_id: target.stage_id ?? null,
        transfer_to_area: vals.auto_transfer ? vals.transfer_to_area ?? null : null,
        note: vals.note,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["pf-demand"] });
      qc.invalidateQueries({ queryKey: ["part-units"] });
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success(
        res.area
          ? `Выпущено ${res.quantity_pieces} шт и сразу передано на «${areaName(res.area)}»`
          : `Выпущено ${res.quantity_pieces} шт на склад ПФ`,
      );
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Ошибка выпуска")),
  });

  return (
    <Modal
      title={
        <Space>
          <span>🏭 Выпуск полуфабрикатов:</span>
          <b>{target.part_name}</b>
        </Space>
      }
      open
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          quantity_pieces: target.suggested_qty > 0 ? target.suggested_qty : 100,
          auto_transfer: !!target.target_area,
          transfer_to_area: target.target_area || (areas[0]?.code ?? ""),
          note: "Выпуск мастером ПФ",
        }}
        onFinish={(vals) => mutation.mutate(vals)}
      >
        <Form.Item
          name="quantity_pieces"
          label="Количество к выпуску, шт"
          rules={[{ required: true, message: "Укажите количество" }]}
        >
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="auto_transfer" valuePropName="checked">
          <Checkbox>Сразу передать на участок цеха (минуя хранение на складе)</Checkbox>
        </Form.Item>
        {autoTransfer && (
          <Form.Item
            name="transfer_to_area"
            label="Целевой участок цеха"
            rules={[{ required: true, message: "Выберите участок" }]}
          >
            <Select
              options={areas.map((a) => ({ value: a.code, label: a.name }))}
              placeholder="Выберите целевой участок"
            />
          </Form.Item>
        )}
        <Form.Item name="note" label="Примечание">
          <Input.TextArea rows={2} />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending} style={{ height: 40, marginTop: 8 }}>
          Выпустить продукцию
        </Button>
      </Form>
    </Modal>
  );
}

type NormForm = { min_stock?: number | null; min_batch?: number | null; batch_multiple?: number | null };

/** Нормативы детали — у её позиции номенклатуры */
function MinValuesModal({ row, onClose }: { row: PfDemandRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<NormForm>();
  const mutation = useMutation({
    mutationFn: (v: NormForm) =>
      setNormatives(row.item_id!, { min_stock: v.min_stock ?? null, min_batch: v.min_batch ?? null, batch_multiple: v.batch_multiple ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pf-demand"] });
      qc.invalidateQueries({ queryKey: ["parts"] });
      qc.invalidateQueries({ queryKey: ["item-normatives", row.item_id] });
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
        initialValues={{
          min_stock: row.min_stock ?? undefined,
          min_batch: row.min_batch ?? undefined,
          batch_multiple: row.batch_multiple ?? undefined,
        }}
        onFinish={(v) => mutation.mutate(v)}
      >
        <Form.Item name="min_stock" label="Минимальный остаток, шт" extra="Пусто — не держать запас сверх заданий">
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="min_batch" label="Минимальная партия производства, шт" extra="Пусто — производить ровно нехватку">
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="batch_multiple" label="Кратность партии, шт" extra="Партия округляется вверх до кратного; пусто — любая">
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
          Сохранить
        </Button>
      </Form>
    </Modal>
  );
}
