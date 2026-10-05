import { useEffect, useMemo, useRef, useState } from "react";
import dayjs from "dayjs";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Empty,
  InputNumber,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listAreas } from "../../../api/areas";
import {
  EMPTY_PLAN,
  getReleaseLayout,
  getReleasePreview,
  getReleaseSettings,
  releaseProductionOrder,
  saveReleaseSettings,
  type LineOverride,
  type OrderLine,
  type PfNeed,
  type PfPick,
  type ProductionOrder,
  type ReleaseLayoutSheet,
  type ReleasePlan,
  type ReleaseSettings,
} from "../../../api/productionOrders";
import type { PfDemandRow } from "../../../api/pfDemand";
import LaminationAreaSelect from "../../../components/LaminationAreaSelect";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { ItemChars } from "../../../components/ItemChars";
import { apiErrorMessage } from "../../../utils/apiError";
import { EditLineModal, SectionsView, SheetTable, d, period, type Agg, type SectionItem } from "./LayoutSheets";

const keyOf = (n: PfNeed) => `${n.order_line_id}|${n.part_id}|${n.consumer_part_id ?? ""}`;
type PfState = ReleaseSettings["pf"][string];

/** Запуск заказа — одно рабочее место на странице черновика (05.10).
 * Всё, что решается перед запуском, — здесь, разделами слева: строки
 * заказа, п/ф (со склада / в работу), площадки ламинации, сроки, листы
 * участков с правкой строк, плёнка, материалы, замечания. Сверху — итог и
 * «Запустить заказ». Настройка сохраняется в черновике сама: закрыли,
 * вернулись — продолжаете с того же места. */
export default function ReleaseWorkspace({
  order,
  canManage,
  onEditLines,
}: {
  order: ProductionOrder;
  canManage: boolean;
  onEditLines: () => void;
}) {
  const qc = useQueryClient();
  const needsQuery = useQuery({ queryKey: ["release-preview", order.id], queryFn: () => getReleasePreview(order.id) });
  const savedQuery = useQuery({ queryKey: ["release-settings", order.id], queryFn: () => getReleaseSettings(order.id), staleTime: 0 });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaName = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : null);
  const needs = useMemo(() => needsQuery.data ?? [], [needsQuery.data]);

  // --- настройка: из сохранённой в черновике, недостающее — по расчёту
  const [pf, setPf] = useState<Record<string, PfState>>({});
  const [overrides, setOverrides] = useState<Record<string, LineOverride>>({});
  const [plan, setPlan] = useState<ReleasePlan>(EMPTY_PLAN);
  const [ready, setReady] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  useEffect(() => {
    if (ready || !needsQuery.data || !savedQuery.data) return;
    const saved = savedQuery.data.settings;
    const next: Record<string, PfState> = {};
    for (const n of needsQuery.data) {
      const k = keyOf(n);
      next[k] = saved?.pf?.[k] ?? { picked: true, qty: n.launch ?? n.quantity, stock: n.from_stock ?? 0, lam: null };
    }
    setPf(next);
    setOverrides(saved?.overrides ?? {});
    setPlan(saved?.plan ?? EMPTY_PLAN);
    setSavedAt(savedQuery.data.updated_at);
    setReady(true);
  }, [ready, needsQuery.data, savedQuery.data]);

  // --- сохранение по ходу (через секунду после последней правки)
  const settings: ReleaseSettings = useMemo(() => ({ pf, overrides, plan }), [pf, overrides, plan]);
  const first = useRef(true);
  const saveMutation = useMutation({
    mutationFn: (s: ReleaseSettings) => saveReleaseSettings(order.id, s),
    onSuccess: (r) => setSavedAt(r.updated_at),
  });
  useEffect(() => {
    if (!ready || !canManage) return;
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => saveMutation.mutate(settings), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, ready]);

  // --- п/ф и площадки
  const st = (n: PfNeed) => pf[keyOf(n)] ?? { picked: true, qty: n.quantity, stock: 0, lam: null };
  const patchPf = (n: PfNeed, p: Partial<PfState>) => setPf((prev) => ({ ...prev, [keyOf(n)]: { ...st(n), ...p } }));
  const lamRows = needs.filter((n) => n.lamination_area && st(n).picked && (st(n).qty ?? 0) > 0);
  const unassigned = lamRows.filter((n) => !st(n).lam);
  const factoryCode = needs.find((n) => n.factory_area)?.factory_area ?? null;
  const pressCode = needs.find((n) => n.lamination_area)?.lamination_area ?? null;
  const panelsBy = (code: string | null) => lamRows.filter((n) => st(n).lam === code).reduce((s, n) => s + (st(n).qty ?? 0), 0);
  const setAllLam = (pick: (n: PfNeed) => string | null) =>
    setPf((prev) => {
      const next = { ...prev };
      for (const n of lamRows) next[keyOf(n)] = { ...st(n), lam: pick(n) };
      return next;
    });
  const picks: PfPick[] = useMemo(
    () =>
      needs
        .filter((n) => st(n).picked && ((st(n).qty ?? 0) > 0 || (st(n).stock ?? 0) > 0))
        .map((n) => ({
          order_line_id: n.order_line_id,
          part_id: n.part_id,
          quantity: st(n).qty ?? 0,
          from_stock: st(n).stock ?? 0,
          consumer_part_id: n.consumer_part_id,
          lamination_area: n.lamination_area ? (st(n).lam ?? null) : null,
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [needs, pf],
  );
  const lineName = (id: number) => order.lines.find((l) => l.id === id)?.item_name ?? "";

  // --- раскладка по текущей настройке (пересчёт через полсекунды после правки)
  const overrideList = Object.values(overrides);
  const layoutKey = JSON.stringify([picks, overrideList, plan]);
  const [debouncedKey, setDebouncedKey] = useState(layoutKey);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedKey(layoutKey), 500);
    return () => clearTimeout(t);
  }, [layoutKey]);
  const layoutQuery = useQuery({
    queryKey: ["release-layout", order.id, debouncedKey],
    queryFn: () => {
      const [p, o, pl] = JSON.parse(debouncedKey) as [PfPick[], LineOverride[], ReleasePlan];
      return getReleaseLayout(order.id, p, o, pl);
    },
    enabled: ready,
    staleTime: 0,
    gcTime: 0,
    placeholderData: (prev) => prev,
  });
  const lay = layoutQuery.data;
  const [editing, setEditing] = useState<{ row: Agg; sheet: ReleaseLayoutSheet } | null>(null);
  const saveOverride = (keys: string[], ov: Omit<LineOverride, "key"> | null) => {
    setOverrides((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        if (ov) next[k] = { key: k, ...ov };
        else delete next[k];
      }
      return next;
    });
    setEditing(null);
  };
  const [shiftDraft, setShiftDraft] = useState<number | null>(null);

  // --- запуск
  const release = useMutation({
    mutationFn: () => releaseProductionOrder(order.id, picks, overrideList, plan),
    onSuccess: (o) => {
      for (const k of [["production-orders"], ["production-order", order.id], ["production-tasks"], ["pf-demand"], ["plan-board"]])
        qc.invalidateQueries({ queryKey: k });
      message.success(
        o.plan_late
          ? `Заказ запущен, но к отгрузке не успевает: готово ${dayjs(o.plan_finish).format("DD.MM")}`
          : `Заказ запущен: заданий ${o.task_ids.length}${o.plan_finish ? `, готово к ${dayjs(o.plan_finish).format("DD.MM")}` : ""}`,
      );
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось запустить заказ")),
  });

  if (!ready) return <Spin style={{ display: "block", margin: "48px auto" }} />;

  const doors = order.lines.reduce((s, l) => s + l.quantity, 0);
  const noRoute = order.lines.filter((l) => l.operations.length === 0);
  const warnings = [
    ...noRoute.map((l) => `Нет маршрута — позиция не запустится: ${l.item_name}`),
    ...(unassigned.length ? [`Площадка ламинации не выбрана у ${unassigned.length} строк п/ф`] : []),
    ...(lay?.warnings ?? []),
  ];
  const canRelease = canManage && unassigned.length === 0 && noRoute.length === 0;
  const manualDates = Object.keys(plan.dates).length;

  const items: SectionItem[] = [
    {
      key: "_lines",
      group: "Заказ",
      label: "Строки заказа",
      sub: `${order.lines.length} строк · ${doors} шт`,
      children: <LinesSection order={order} canManage={canManage} onEditLines={onEditLines} />,
    },
    {
      key: "_pf",
      group: "Подготовка",
      label: "П/ф: со склада и в работу",
      sub: needs.length ? `${needs.filter((n) => st(n).picked).length} из ${needs.length} деталей` : "не нужны",
      children: needs.length ? (
        <Space direction="vertical" size="small" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            «Со склада» — свободный остаток уходит в резерв этого заказа; «в работу» — задания на п/ф по маршруту детали.
            Детали «на склад» по умолчанию берутся с остатка, «под заказ» (щиты, панели, детали в плёнке) — запускаются.
          </Typography.Text>
          <Table<PfNeed>
            size="small"
            rowKey={keyOf}
            pagination={false}
            dataSource={needs}
            scroll={{ x: "max-content", y: 560 }}
            columns={[
              {
                title: "",
                width: 40,
                render: (_, n) => <Checkbox checked={st(n).picked} disabled={!canManage} onChange={(e) => patchPf(n, { picked: e.target.checked })} />,
              },
              {
                title: "Деталь",
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
              { title: "Нужно", align: "right", render: (_, n) => n.quantity },
              { title: "Свободно на складе", align: "right", render: (_, n) => (n.free_stock > 0 ? <b>{n.free_stock}</b> : "0") },
              {
                title: "Со склада",
                render: (_, n) =>
                  n.free_stock > 0 ? (
                    <InputNumber
                      size="small"
                      min={0}
                      max={Math.min(n.free_stock, n.quantity)}
                      style={{ width: 90 }}
                      disabled={!st(n).picked || !canManage}
                      value={st(n).stock}
                      onChange={(v) => {
                        const take = v ?? 0;
                        patchPf(n, { stock: take, qty: Math.max(0, Math.round((n.quantity - take) * 100) / 100) });
                      }}
                    />
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  ),
              },
              {
                title: "В работу",
                render: (_, n) => (
                  <InputNumber
                    size="small"
                    min={0}
                    style={{ width: 100 }}
                    disabled={!st(n).picked || !canManage}
                    value={st(n).qty}
                    onChange={(v) => patchPf(n, { qty: v })}
                  />
                ),
              },
            ]}
          />
        </Space>
      ) : (
        <Empty description="П/ф по составу позиций не нужны" />
      ),
    },
    ...(lamRows.length || needs.some((n) => n.lamination_area)
      ? [
          {
            key: "_lam",
            group: "Подготовка",
            label: "Площадки ламинации",
            sub: unassigned.length ? `не выбрано: ${unassigned.length}` : "выбраны",
            mark: unassigned.length ? "нужно выбрать" : undefined,
            children: (
              <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                <Alert
                  type={unassigned.length ? "warning" : "success"}
                  showIcon
                  message={
                    unassigned.length
                      ? `Выберите площадку: не распределено строк ${unassigned.length} (${unassigned.reduce((s, n) => s + (st(n).qty ?? 0), 0)} шт)`
                      : "Ламинация панелей распределена"
                  }
                  description={
                    <Space wrap>
                      {factoryCode && canManage && (
                        <Button size="small" onClick={() => setAllLam((n) => n.factory_area)}>
                          Всё на окутку ({areaName(factoryCode)})
                        </Button>
                      )}
                      {pressCode && canManage && (
                        <Button size="small" onClick={() => setAllLam((n) => n.lamination_area)}>
                          Всё на {areaName(pressCode)}
                        </Button>
                      )}
                      {factoryCode && canManage && (
                        <Button
                          size="small"
                          onClick={() => {
                            // по правилу участка: панель одного цвета и размера по заказу от порога — на Фабрику
                            const per = new Map<number, number>();
                            for (const n of lamRows) per.set(n.part_id, (per.get(n.part_id) ?? 0) + (st(n).qty ?? 0));
                            setAllLam((n) =>
                              n.factory_area && n.factory_min_pieces && (per.get(n.part_id) ?? 0) >= n.factory_min_pieces
                                ? n.factory_area
                                : n.lamination_area,
                            );
                          }}
                        >
                          По размеру партии
                        </Button>
                      )}
                      {factoryCode && <Tag>{areaName(factoryCode)}: {panelsBy(factoryCode)} шт</Tag>}
                      {pressCode && <Tag>{areaName(pressCode)}: {panelsBy(pressCode)} шт</Tag>}
                    </Space>
                  }
                />
                <Table<PfNeed>
                  size="small"
                  rowKey={keyOf}
                  pagination={false}
                  dataSource={lamRows}
                  scroll={{ y: 520 }}
                  columns={[
                    { title: "Панель", render: (_, n) => n.part_name },
                    { title: "Для", render: (_, n) => <Typography.Text type="secondary">{lineName(n.order_line_id)}</Typography.Text> },
                    { title: "Шт", align: "right", render: (_, n) => st(n).qty },
                    {
                      title: "Площадка",
                      render: (_, n) => (
                        <LaminationAreaSelect
                          row={{ lamination_area: n.lamination_area, factory_area: n.factory_area, factory_min_pieces: n.factory_min_pieces } as PfDemandRow}
                          value={st(n).lam ?? undefined}
                          areaName={areaName}
                          disabled={!canManage}
                          onChange={(v) => patchPf(n, { lam: v })}
                        />
                      ),
                    },
                  ]}
                />
              </Space>
            ),
          } as SectionItem,
        ]
      : []),
    {
      key: "_dates",
      group: "Подготовка",
      label: "Сроки",
      sub: lay ? `готово к ${d(lay.finish)}${lay.late ? " · не успевает" : ""}` : "",
      mark: manualDates || plan.shift_days ? "вручную" : undefined,
      children: (
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <Typography.Text type="secondary">
            Сроки считаются назад от отгрузки {order.ship_date ? dayjs(order.ship_date).format("DD.MM.YYYY") : "(не указана — от сегодня)"} по
            рабочим дням и сроку операции каждого участка. Можно поставить участок на дату или сдвинуть весь заказ.
          </Typography.Text>
          {canManage && (
            <Space wrap>
              <Typography.Text>Весь заказ: сдвинуть на</Typography.Text>
              <InputNumber size="small" style={{ width: 80 }} value={shiftDraft ?? (plan.shift_days || null)} onChange={setShiftDraft} placeholder="±дн." />
              <Typography.Text>рабочих дней</Typography.Text>
              <Button size="small" onClick={() => setPlan({ ...plan, shift_days: shiftDraft ?? 0 })}>
                Применить
              </Button>
              <Checkbox checked={plan.shift_next} onChange={(e) => setPlan({ ...plan, shift_next: e.target.checked })}>
                при переносе участка сдвигать следующие этапы
              </Checkbox>
              {(manualDates > 0 || plan.shift_days !== 0) && (
                <Button
                  size="small"
                  onClick={() => {
                    setShiftDraft(null);
                    setPlan({ ...plan, dates: {}, shift_days: 0 });
                  }}
                >
                  Сбросить сроки
                </Button>
              )}
            </Space>
          )}
          <Table<ReleaseLayoutSheet>
            size="small"
            rowKey="area"
            pagination={false}
            loading={layoutQuery.isFetching && !lay}
            dataSource={lay?.sheets ?? []}
            columns={[
              { title: "Участок", dataIndex: "name" },
              { title: "Шт", dataIndex: "total", align: "right" },
              { title: "По расчёту", render: (_, s) => period(s.date_from, s.date_to) },
              {
                title: "Поставить на дату",
                render: (_, s) => (
                  <DatePicker
                    size="small"
                    format="DD.MM.YYYY"
                    disabled={!canManage}
                    value={plan.dates[s.area] ? dayjs(plan.dates[s.area]) : null}
                    onChange={(v) => {
                      const dates = { ...plan.dates };
                      if (v) dates[s.area] = v.format("YYYY-MM-DD");
                      else delete dates[s.area];
                      setPlan({ ...plan, dates });
                    }}
                  />
                ),
              },
            ]}
          />
        </Space>
      ),
    },
    ...(lay?.sheets ?? []).map(
      (s): SectionItem => ({
        key: s.area,
        group: "Участки — что родится",
        label: s.name,
        sub: `${s.total} шт · ${period(s.date_from, s.date_to)}${s.pf ? " · п/ф" : ""}`,
        mark: plan.dates[s.area] ? "срок вручную" : s.rows.some((r) => overrides[r.key] || r.manual) ? "правки" : undefined,
        children: (
          <SheetTable
            sheet={s}
            overrides={overrides}
            onEdit={canManage ? (row) => setEditing({ row, sheet: s }) : undefined}
            date={plan.dates[s.area]}
            onDate={
              canManage
                ? (dt) => {
                    const dates = { ...plan.dates };
                    if (dt) dates[s.area] = dt;
                    else delete dates[s.area];
                    setPlan({ ...plan, dates });
                  }
                : undefined
            }
          />
        ),
      }),
    ),
    {
      key: "_film",
      group: "Итог",
      label: "Плёнка",
      sub: lay ? `${lay.film.length} позиций${lay.film.some((f) => f.stock_m < f.need_m) ? " · не хватает" : ""}` : "",
      mark: lay?.film.some((f) => f.stock_m < f.need_m) ? "не хватает" : undefined,
      children: lay?.film.length ? (
        <ResponsiveTable
          exportTitle={`Запуск заказа №${order.id}: плёнка`}
          cardBreakpoint="xs"
          size="small"
          rowKey={(r) => `${r.area}|${r.label}`}
          pagination={false}
          dataSource={lay.film}
          columns={[
            { title: "Участок", dataIndex: "area_name" },
            { title: "Плёнка", dataIndex: "label" },
            { title: "Нужно, м", dataIndex: "need_m", align: "right" },
            {
              title: "На складе площадки, м",
              align: "right",
              render: (_, r) => (
                <Space size={4}>
                  <span>{r.stock_m}</span>
                  {r.stock_m < r.need_m ? <Tag color="red">не хватает</Tag> : <Tag color="green">хватает</Tag>}
                </Space>
              ),
            },
            {
              title: "Как выдаётся",
              render: (_, r) => (r.cut_on_site ? `рулон не уже ${r.min_width_mm} мм, режут на участке` : `штрипсы от ${r.min_width_mm} мм, режет склад`),
            },
          ]}
        />
      ) : (
        <Empty description="Плёнки в этом запуске нет" />
      ),
    },
    {
      key: "_mat",
      group: "Итог",
      label: "Материалы и комплектующие",
      sub: lay ? `${lay.materials.length} позиций` : "",
      children: (
        <ResponsiveTable
          exportTitle={`Запуск заказа №${order.id}: материалы и комплектующие`}
          cardBreakpoint="xs"
          size="small"
          rowKey="name"
          pagination={false}
          scroll={{ y: 560 }}
          dataSource={lay?.materials ?? []}
          columns={[
            { title: "Наименование", dataIndex: "name" },
            { title: "Количество", align: "right", render: (_, r) => `${Math.round(r.qty * 100) / 100} ${r.unit ?? "шт"}` },
          ]}
        />
      ),
    },
    {
      key: "_warn",
      group: "Итог",
      label: "Замечания",
      sub: warnings.length ? "есть — проверьте" : "нет",
      mark: warnings.length ? String(warnings.length) : undefined,
      children: warnings.length ? (
        <Alert
          type="warning"
          showIcon
          message="Проверьте перед запуском"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          }
        />
      ) : (
        <Alert type="success" showIcon message="Замечаний нет: маршруты есть, площадки выбраны, плёнка определена и хватает" />
      ),
    },
  ];

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Card size="small" style={{ position: "sticky", top: 0, zIndex: 5 }}>
        <Space wrap size={[16, 8]} style={{ width: "100%", justifyContent: "space-between" }}>
          <Space wrap size={[16, 4]}>
            <Typography.Text>
              Дверей <b>{doors}</b> · строк <b>{order.lines.length}</b> · отгрузка{" "}
              <b>{order.ship_date ? dayjs(order.ship_date).format("DD.MM.YYYY") : "не указана"}</b>
            </Typography.Text>
            {lay ? (
              <Typography.Text>
                участков <b>{lay.sheets.length}</b> · готово к <b>{d(lay.finish)}</b>{" "}
                {lay.late ? <Tag color="red">не успевает</Tag> : <Tag color="green">успевает</Tag>}
              </Typography.Text>
            ) : (
              <Spin size="small" />
            )}
            {layoutQuery.isFetching && lay && (
              <Typography.Text type="secondary">
                <Spin size="small" /> пересчёт…
              </Typography.Text>
            )}
            {warnings.length > 0 ? <Tag color="orange">замечаний: {warnings.length}</Tag> : <Tag color="green">замечаний нет</Tag>}
            {overrideList.length > 0 && <Tag color="orange">правок строк: {overrideList.length}</Tag>}
          </Space>
          <Space wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {saveMutation.isPending ? "сохраняю…" : savedAt ? `настройка сохранена ${dayjs(savedAt).format("DD.MM HH:mm")}` : "настройка по расчёту"}
            </Typography.Text>
            {canManage && (
              <Tooltip title={!canRelease ? "Сначала уберите замечания: маршруты и площадки ламинации" : "Создать задания участкам и п/ф по этой настройке"}>
                <Button type="primary" size="large" disabled={!canRelease} loading={release.isPending} onClick={() => release.mutate()}>
                  Запустить заказ
                </Button>
              </Tooltip>
            )}
          </Space>
        </Space>
      </Card>
      <SectionsView items={items} initial={unassigned.length ? "_lam" : "_lines"} />
      {editing && (
        <EditLineModal row={editing.row} sheet={editing.sheet} overrides={overrides} onSave={saveOverride} onClose={() => setEditing(null)} />
      )}
    </Space>
  );
}

/** Строки заказа: изделие характеристиками, количество, счёт, маршрут. */
function LinesSection({ order, canManage, onEditLines }: { order: ProductionOrder; canManage: boolean; onEditLines: () => void }) {
  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      <Space style={{ justifyContent: "space-between", width: "100%" }}>
        <Typography.Text type="secondary">
          {order.note ?? ""} {order.category_name ? `· категория «${order.category_name}»` : ""}
        </Typography.Text>
        {canManage && <Button onClick={onEditLines}>Изменить строки заказа</Button>}
      </Space>
      <ResponsiveTable<OrderLine>
        exportTitle={`Заказ №${order.id} «${order.name}»: строки`}
        size="small"
        rowKey="id"
        pagination={false}
        dataSource={order.lines}
        scroll={{ x: "max-content", y: 600 }}
        columns={[
          { title: "Изделие", render: (_, l) => <ItemChars chars={l.item_chars} name={l.item_name} strong={false} /> },
          { title: "Шт", dataIndex: "quantity", align: "right", render: (v: number) => <b>{v}</b> },
          { title: "Счёт", render: (_, l) => l.invoice_no ?? "" },
          { title: "Примечание", render: (_, l) => l.note ?? "" },
          {
            title: "Маршрут",
            render: (_, l) =>
              l.operations.length ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {l.operations.map((o) => o.name).join(" → ")}
                </Typography.Text>
              ) : (
                <Tag color="red">нет маршрута</Tag>
              ),
          },
        ]}
      />
    </Space>
  );
}
