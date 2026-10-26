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
  getOrderLamination,
  getReleasePreview,
  getReleaseSettings,
  releaseProductionOrder,
  saveReleaseSettings,
  type LineOverride,
  type OrderComponent,
  type OrderLine,
  type PfNeed,
  type PfPick,
  type ProductionOrder,
  type ReleaseLayout,
  type ReleaseLayoutSheet,
  type ReleasePlan,
  type ReleaseSettings,
} from "../../../api/productionOrders";
import type { PfDemandRow } from "../../../api/pfDemand";
import LaminationAreaSelect from "../../../components/LaminationAreaSelect";
import GroupedTable from "../../../components/GroupedTable";
import LineOptions from "../../../components/LineOptions";
import OptionsToClarify, { saveOrderLineOptions } from "./OptionsToClarify";
import { ItemChars } from "../../../components/ItemChars";
import { apiErrorMessage } from "../../../utils/apiError";
import { EditLineModal, SectionsView, SheetTable, d, period, type Agg, type SectionItem } from "./LayoutSheets";

const keyOf = (n: PfNeed) => `${n.order_line_id}|${n.part_id}|${n.consumer_part_id ?? ""}`;
type PfState = ReleaseSettings["pf"][string];
const r2 = (v: number) => Math.round(v * 100) / 100;
const sumOf = <T,>(rows: T[], f: (r: T) => number | null | undefined) => r2(rows.reduce((s, r) => s + (f(r) ?? 0), 0));
// панель «Панель щитовой двери 6х610х2010 (ПЭТ Белый)»: размер и цвет из названия
const panelSize = (name: string) => name.match(/(\d+(?:[.,]\d+)?)\s*[хx×]\s*(\d+)\s*[хx×]\s*(\d+)/i)?.slice(1, 4).join("х") ?? "";
const nameColor = (name: string) => name.match(/\(([^)]+)\)\s*$/)?.[1]?.trim() ?? "";
const charOf = (l: OrderLine | undefined, code: string) => l?.item_chars?.find((c) => c.code === code)?.value ?? "";
const lineSize = (l: OrderLine | undefined) => {
  const w = charOf(l, "ширина").replace(/\s*мм$/, "");
  const h = charOf(l, "высота").replace(/\s*мм$/, "");
  return w && h ? `${w}х${h}` : "";
};
const routeOf = (l: OrderLine) => (l.operations.length ? l.operations.map((o) => o.name).join(" → ") : l.without_route ? "без этапов" : "нет маршрута");

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
  // Окутка, запущенная отдельно (09.10): эти панели площадку уже получили —
  // при запуске их окутка не повторяется, выбирать её здесь не нужно.
  const hasPrelaunch = (order.tasks ?? []).length > 0;
  const lamQuery = useQuery({
    queryKey: ["order-lamination", order.id],
    queryFn: () => getOrderLamination(order.id),
    enabled: hasPrelaunch,
  });
  const prelaunched = useMemo(
    () => new Set((lamQuery.data ?? []).filter((r) => r.launched > 0 && r.launched >= r.quantity).map((r) => r.part_id)),
    [lamQuery.data],
  );

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
      if (n.lam_forced) next[k] = { ...next[k], lam: n.lam_forced };
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
  const lamRows = needs.filter((n) => n.lamination_area && st(n).picked && (st(n).qty ?? 0) > 0 && !prelaunched.has(n.part_id));
  const unassigned = lamRows.filter((n) => !st(n).lam);
  const factoryCode = needs.find((n) => n.factory_area)?.factory_area ?? null;
  const pressCode = needs.find((n) => n.lamination_area)?.lamination_area ?? null;
  const panelsBy = (code: string | null) => lamRows.filter((n) => st(n).lam === code).reduce((s, n) => s + (st(n).qty ?? 0), 0);
  const setAllLam = (pick: (n: PfNeed) => string | null) =>
    setPf((prev) => {
      const next = { ...prev };
      for (const n of lamRows) next[keyOf(n)] = { ...st(n), lam: n.lam_forced ?? pick(n) };
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
  const lineOf = (id: number) => order.lines.find((l) => l.id === id);
  const lineName = (id: number) => lineOf(id)?.item_name ?? "";
  const invoiceOf = (n: PfNeed) => lineOf(n.order_line_id)?.invoice_no ?? "";
  const colorOf = (n: PfNeed) => nameColor(n.part_name) || charOf(lineOf(n.order_line_id), "цвет");
  const setLamFor = (rows: PfNeed[], v: string) =>
    setPf((prev) => {
      const next = { ...prev };
      for (const n of rows) next[keyOf(n)] = { ...st(n), lam: n.lam_forced ?? v };
      return next;
    });
  // разбивка группы по площадкам: «Фабрика 120 · Прессы 40 · не выбрано 8»
  const lamBreakdown = (rows: PfNeed[]) => {
    const by = new Map<string, number>();
    for (const n of rows) by.set(st(n).lam ?? "", (by.get(st(n).lam ?? "") ?? 0) + (st(n).qty ?? 0));
    return [...by.entries()].map(([code, q]) => `${code ? areaName(code) : "не выбрано"} ${r2(q)}`).join(" · ");
  };

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
  // шлифовка «Да/Нет» (07.10): пометка «не делать» у строк, прочие правки строки сохраняются
  const setSkip = (keys: string[], skip: boolean) =>
    setOverrides((prev) => {
      const next = { ...prev };
      for (const k of keys) {
        const cur = next[k] ?? ({ key: k } as LineOverride);
        const ov = { ...cur, key: k, skip };
        const empty = !skip && Object.entries(ov).every(([f, v]) => f === "key" || f === "skip" || v == null || v === "");
        if (empty) delete next[k];
        else next[k] = ov;
      }
      return next;
    });
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
  // общий заказ — в названии и шапке всех печатных форм и Excel (13.10)
  const orderTitle = `Заказ №${order.id} «${order.name}»`;
  const noRoute = order.lines.filter((l) => l.operations.length === 0 && !l.without_route);
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
      // исполнение не из счёта (26.10) — уточнить до запуска
      mark: order.lines.some((l) => (l.option_fields ?? []).some((f) => !(l.options ?? []).some((o) => o.code === f.code && o.value)))
        ? "уточнить исполнение"
        : undefined,
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
          <GroupedTable<PfNeed>
            storageKey="release.pf"
            dims={[
              { key: "part", label: "Деталь", value: (n) => n.part_name },
              { key: "invoice", label: "Счёт", value: invoiceOf },
              { key: "item", label: "Для изделия", value: (n) => lineName(n.order_line_id) },
              { key: "mode", label: "Как", value: (n) => (n.mode === "stock" ? "на склад" : n.mode ? "под заказ" : "") },
            ]}
            defaultDims={[]}
            size="small"
            rowKey={keyOf}
            pagination={false}
            dataSource={needs}
            scroll={{ x: "max-content", y: 560 }}
            labelColumn="part"
            columns={[
              {
                key: "pick",
                title: "",
                width: 40,
                render: (_, n) => <Checkbox checked={st(n).picked} disabled={!canManage} onChange={(e) => patchPf(n, { picked: e.target.checked })} />,
                groupRender: (rows) => {
                  const on = rows.filter((n) => st(n).picked).length;
                  return (
                    <Checkbox
                      checked={on === rows.length}
                      indeterminate={on > 0 && on < rows.length}
                      disabled={!canManage}
                      onChange={(e) =>
                        setPf((prev) => {
                          const next = { ...prev };
                          for (const n of rows) next[keyOf(n)] = { ...st(n), picked: e.target.checked };
                          return next;
                        })
                      }
                    />
                  );
                },
              },
              {
                key: "part",
                title: "Деталь",
                sortValue: (n) => n.part_name,
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
              {
                key: "need",
                title: "Нужно",
                align: "right",
                sortValue: (n) => n.quantity,
                render: (_, n) => n.quantity,
                groupRender: (rows) => <b>{sumOf(rows, (n) => n.quantity)}</b>,
              },
              {
                key: "free",
                title: "Свободно на складе",
                align: "right",
                sortValue: (n) => n.free_stock,
                render: (_, n) => (n.free_stock > 0 ? <b>{n.free_stock}</b> : "0"),
                // остаток — у детали, не у строки: по разным деталям группы
                groupRender: (rows) => sumOf([...new Map(rows.map((n) => [n.part_id, n.free_stock])).values()], (v) => v),
              },
              {
                key: "stock",
                title: "Со склада",
                sortValue: (n) => st(n).stock ?? 0,
                groupRender: (rows) => <b>{sumOf(rows, (n) => st(n).stock)}</b>,
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
                key: "launch",
                title: "В работу",
                sortValue: (n) => st(n).qty ?? 0,
                groupRender: (rows) => <b>{sumOf(rows, (n) => st(n).qty)}</b>,
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
                <Typography.Text type="secondary">
                  Площадка в строке группы — на все панели внутри; ниже можно поменять отдельную строку, итог группы покажет разбивку.
                </Typography.Text>
                <GroupedTable<PfNeed>
                  storageKey="release.lam"
                  dims={[
                    { key: "size", label: "Размер панели", value: (n) => panelSize(n.part_name) },
                    { key: "color", label: "Цвет", value: colorOf },
                    { key: "invoice", label: "Счёт", value: invoiceOf },
                    { key: "item", label: "Изделие", value: (n) => lineName(n.order_line_id) },
                    { key: "site", label: "Площадка", value: (n) => (st(n).lam ? (areaName(st(n).lam ?? null) ?? "") : "не выбрана") },
                  ]}
                  defaultDims={["size", "color", "invoice"]}
                  size="small"
                  rowKey={keyOf}
                  pagination={false}
                  dataSource={lamRows}
                  scroll={{ x: "max-content", y: 560 }}
                  columns={[
                    { key: "panel", title: "Панель", sortValue: (n) => n.part_name, render: (_, n) => n.part_name },
                    {
                      key: "qty",
                      title: "Шт",
                      align: "right",
                      sortValue: (n) => st(n).qty ?? 0,
                      render: (_, n) => st(n).qty,
                      groupRender: (rows) => <b>{sumOf(rows, (n) => st(n).qty)}</b>,
                    },
                    {
                      key: "site",
                      title: "Площадка",
                      sortValue: (n) => (st(n).lam ? (areaName(st(n).lam ?? null) ?? "") : ""),
                      render: (_, n) =>
                        n.lam_forced ? (
                          <Tooltip title="Панель фрезеруют после ламинации (ПЭТ, молдинг М5х3/М3х3) — фрезеровка на Фабрике, ламинация там же">
                            <Tag color="blue">{areaName(n.lam_forced)} · фрезеровка после</Tag>
                          </Tooltip>
                        ) : (
                          <LaminationAreaSelect
                            row={{ lamination_area: n.lamination_area, factory_area: n.factory_area, factory_min_pieces: n.factory_min_pieces } as PfDemandRow}
                            value={st(n).lam ?? undefined}
                            areaName={areaName}
                            disabled={!canManage}
                            onChange={(v) => patchPf(n, { lam: v })}
                          />
                        ),
                      groupRender: (rows) => {
                        const vals = new Set(rows.map((n) => st(n).lam ?? ""));
                        const common = vals.size === 1 ? [...vals][0] : "";
                        const first = rows.find((n) => n.lamination_area && n.factory_area) ?? rows[0];
                        return (
                          <Space direction="vertical" size={2}>
                            <LaminationAreaSelect
                              row={{ lamination_area: first.lamination_area, factory_area: first.factory_area, factory_min_pieces: first.factory_min_pieces } as PfDemandRow}
                              value={common || undefined}
                              placeholder={vals.size > 1 ? "разные — выбрать для всех" : "выбрать для всех"}
                              areaName={areaName}
                              disabled={!canManage}
                              onChange={(v) => setLamFor(rows, v)}
                            />
                            {vals.size > 1 && (
                              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                {lamBreakdown(rows)}
                              </Typography.Text>
                            )}
                          </Space>
                        );
                      },
                    },
                    { key: "invoice", title: "Счёт", sortValue: invoiceOf, render: (_, n) => invoiceOf(n) },
                    {
                      key: "for",
                      title: "Для",
                      width: 360,
                      ellipsis: true,
                      sortValue: (n) => lineName(n.order_line_id),
                      render: (_, n) => <Typography.Text type="secondary">{lineName(n.order_line_id)}</Typography.Text>,
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
          <GroupedTable<ReleaseLayoutSheet>
            storageKey="release.dates"
            dims={[
              { key: "period", label: "Срок по расчёту", value: (s) => period(s.date_from, s.date_to) },
              { key: "manual", label: "Срок", value: (s) => (plan.dates[s.area] ? "вручную" : "по расчёту") },
            ]}
            defaultDims={[]}
            size="small"
            rowKey={(s) => s.key ?? s.area}
            pagination={false}
            loading={layoutQuery.isFetching && !lay}
            dataSource={lay?.sheets ?? []}
            columns={[
              { key: "name", title: "Участок", sortValue: (s) => s.name, render: (_, s) => s.name },
              {
                key: "total",
                title: "Шт",
                align: "right",
                sortValue: (s) => s.total,
                render: (_, s) => s.total,
                groupRender: (rows) => <b>{sumOf(rows, (s) => s.total)}</b>,
              },
              { key: "calc", title: "По расчёту", sortValue: (s) => s.date_from ?? "", render: (_, s) => period(s.date_from, s.date_to) },
              {
                key: "set",
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
        key: s.key ?? s.area,
        group: "Задания участкам",
        label: s.name,
        sub: `${s.total} шт · ${period(s.date_from, s.date_to)}${s.pf ? " · п/ф" : ""}`,
        mark: plan.dates[s.area] ? "срок вручную" : s.rows.some((r) => overrides[r.key] || r.manual) ? "правки" : undefined,
        children: (
          <SheetTable
            sheet={s}
            orderTitle={orderTitle}
            orderNote={order.note}
            overrides={overrides}
            onEdit={canManage ? (row) => setEditing({ row, sheet: s }) : undefined}
            onSkip={canManage ? setSkip : undefined}
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
        <GroupedTable<ReleaseLayout["film"][number]>
          storageKey="release.film"
          dims={[
            { key: "area", label: "Участок", value: (r) => r.area_name },
            { key: "film", label: "Плёнка", value: (r) => r.label },
            { key: "enough", label: "Хватает", value: (r) => (r.stock_m < r.need_m ? "не хватает" : "хватает") },
          ]}
          defaultDims={[]}
          exportTitle={`${orderTitle}: плёнка`}
          exportNote={order.note ? `Комментарий: ${order.note}` : undefined}
          cardBreakpoint="xs"
          size="small"
          rowKey={(r) => `${r.area}|${r.label}`}
          pagination={false}
          dataSource={lay.film}
          columns={[
            { key: "area", title: "Участок", sortValue: (r) => r.area_name, render: (_, r) => r.area_name },
            { key: "film", title: "Плёнка", sortValue: (r) => r.label, render: (_, r) => r.label },
            {
              key: "need",
              title: "Нужно, м",
              align: "right",
              sortValue: (r) => r.need_m,
              render: (_, r) => r.need_m,
              groupRender: (rows) => <b>{sumOf(rows, (r) => r.need_m)}</b>,
            },
            {
              key: "stock",
              title: "На складе площадки, м",
              align: "right",
              sortValue: (r) => r.stock_m,
              render: (_, r) => (
                <Space size={4}>
                  <span>{r.stock_m}</span>
                  {r.stock_m < r.need_m ? <Tag color="red">не хватает</Tag> : <Tag color="green">хватает</Tag>}
                </Space>
              ),
            },
            {
              key: "how",
              title: "Как выдаётся",
              sortValue: (r) => (r.cut_on_site ? 1 : 0),
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
      // 13.10: каждая группа (комплектующие, МДФ, пенопласт…) — отдельным
      // блоком со своей печатью и Excel
      children: (
        <Space direction="vertical" size="large" style={{ width: "100%" }}>
          {[...new Set((lay?.materials ?? []).map((m) => m.group ?? "Прочее"))].map((g) => {
            const rows = (lay?.materials ?? []).filter((m) => (m.group ?? "Прочее") === g);
            return (
              <div key={g}>
                <Typography.Title level={5} style={{ marginTop: 0 }}>
                  {g} <Typography.Text type="secondary">· {rows.length}</Typography.Text>
                </Typography.Title>
                <GroupedTable<ReleaseLayout["materials"][number]>
                  storageKey={`release.mat.${g}`}
                  dims={[
                    { key: "where", label: "Где расходуется", value: (r) => (r.areas ?? []).map((a) => a.area_name ?? "—").join(", ") },
                    { key: "unit", label: "Единица", value: (r) => r.unit ?? "шт" },
                  ]}
                  defaultDims={[]}
                  exportTitle={`${orderTitle}: ${g.toLowerCase()}`}
                  exportNote={order.note ? `Комментарий: ${order.note}` : undefined}
                  cardBreakpoint="xs"
                  size="small"
                  rowKey={(r) => r.name}
                  pagination={false}
                  dataSource={rows}
                  columns={[
                    { key: "name", title: "Наименование", sortValue: (r) => r.name, render: (_, r) => r.name },
                    {
                      key: "qty",
                      title: "Количество",
                      align: "right",
                      sortValue: (r) => r.qty,
                      render: (_, r) => `${r2(r.qty)} ${r.unit ?? "шт"}`,
                      // итог — только когда единица у всех одна
                      groupRender: (list) =>
                        new Set(list.map((r) => r.unit ?? "шт")).size === 1 ? <b>{`${sumOf(list, (r) => r.qty)} ${list[0].unit ?? "шт"}`}</b> : null,
                    },
                    ...(rows.some((r) => r.comment)
                      ? [{ key: "comment", title: "Примечание", sortValue: (r: (typeof rows)[number]) => r.comment ?? "", render: (_: unknown, r: (typeof rows)[number]) => r.comment ?? "" }]
                      : []),
                    {
                      key: "where",
                      title: "Где расходуется",
                      render: (_, r) =>
                        (r.areas ?? [])
                          .map((a) => `${a.area_name ?? "—"}${(r.areas ?? []).length > 1 ? `: ${Math.round(a.qty * 100) / 100}` : ""}`)
                          .join("; "),
                    },
                  ]}
                />
              </div>
            );
          })}
        </Space>
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
            {canManage && !canRelease && (
              // причина видна сразу, без наведения (на планшете подсказки нет)
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                Не запускается:{" "}
                {[
                  unassigned.length ? `не выбрана площадка ламинации (${unassigned.length})` : "",
                  noRoute.length ? `нет маршрута у позиций (${noRoute.length})` : "",
                ]
                  .filter(Boolean)
                  .join(", ")}
              </Typography.Text>
            )}
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
/** Состав изделия деревом (20.10): что в него входит, на одно изделие и
 * всего на строку, на каком этапе расходуется. */
function Composition({ list }: { list: OrderComponent[] }) {
  const n = (v: number) => (Math.round(v * 1000) / 1000).toLocaleString("ru-RU");
  return (
    <div style={{ display: "grid", gap: 2, marginTop: 4, fontSize: 12 }}>
      {list.map((c, i) => (
        <div
          key={i}
          style={{
            paddingLeft: 10 + (c.depth ?? 0) * 18,
            borderLeft: "2px solid rgba(201,122,43,.45)",
            display: "flex",
            flexWrap: "wrap",
            gap: "0 8px",
            alignItems: "baseline",
          }}
        >
          <span style={{ fontWeight: (c.depth ?? 0) === 0 ? 600 : 400 }}>
            {(c.depth ?? 0) > 0 ? "└ " : ""}
            {c.name}
          </span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {n(c.per_unit)} {c.unit} на изделие · всего {n(c.total)} {c.unit}
            {c.operation_name ? ` · этап «${c.operation_name}»` : ""}
          </Typography.Text>
        </div>
      ))}
    </div>
  );
}

function LinesSection({ order, canManage, onEditLines }: { order: ProductionOrder; canManage: boolean; onEditLines: () => void }) {
  // раскрыт состав: у отдельных строк или у всех
  const [open, setOpen] = useState<Set<number>>(new Set());
  const withComp = order.lines.filter((l) => (l.composition ?? []).length > 0);
  const allOpen = withComp.length > 0 && withComp.every((l) => open.has(l.id));
  const qc = useQueryClient();
  const hasOptions = order.lines.some((l) => (l.options ?? []).length || (l.option_fields ?? []).length);
  const toggle = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Space direction="vertical" size="small" style={{ width: "100%" }}>
      <Space style={{ justifyContent: "space-between", width: "100%" }} wrap>
        <Typography.Text type="secondary">
          {order.note ?? ""} {order.category_name ? `· категория «${order.category_name}»` : ""}
        </Typography.Text>
        <Space wrap>
          {withComp.length > 0 && (
            <Button onClick={() => setOpen(allOpen ? new Set() : new Set(withComp.map((l) => l.id)))}>
              {allOpen ? "Скрыть состав" : "Показать состав у всех"}
            </Button>
          )}
          {canManage && <Button onClick={onEditLines}>Изменить строки заказа</Button>}
        </Space>
      </Space>
      {/* исполнение (26.10): что не пришло из счёта — уточнить перед запуском */}
      <OptionsToClarify order={order} canManage={canManage} />
      <GroupedTable<OrderLine>
        storageKey="release.lines"
        dims={[
          { key: "invoice", label: "Счёт", value: (l) => l.invoice_no ?? "" },
          { key: "kind", label: "Вид", value: (l) => l.kind_name ?? "" },
          { key: "series", label: "Серия", value: (l) => charOf(l, "серия") },
          { key: "size", label: "Размер", value: lineSize },
          { key: "color", label: "Цвет", value: (l) => charOf(l, "цвет") },
          { key: "route", label: "Маршрут", value: routeOf },
        ]}
        defaultDims={[]}
        exportTitle={`Заказ №${order.id} «${order.name}»: строки`}
        size="small"
        rowKey={(l) => String(l.id)}
        pagination={false}
        dataSource={order.lines}
        scroll={{ x: "max-content", y: 600 }}
        columns={[
          {
            key: "item",
            title: "Изделие",
            sortValue: (l) => l.item_name,
            render: (_, l) => {
              const comp = l.composition ?? [];
              return (
                <div>
                  <ItemChars chars={l.item_chars} name={l.item_name} strong={false} />
                  {comp.length > 0 && (
                    <Button type="link" size="small" style={{ padding: 0, height: "auto" }} aria-expanded={open.has(l.id)} onClick={() => toggle(l.id)}>
                      {open.has(l.id) ? "▾ скрыть состав" : `▸ из чего состоит (${comp.filter((c) => (c.depth ?? 0) === 0).length})`}
                    </Button>
                  )}
                  {open.has(l.id) && <Composition list={comp} />}
                </div>
              );
            },
          },
          {
            key: "qty",
            title: "Шт",
            align: "right",
            sortValue: (l) => l.quantity,
            render: (_, l) => <b>{l.quantity}</b>,
            groupRender: (rows) => <b>{sumOf(rows, (l) => l.quantity)}</b>,
          },
          { key: "invoice", title: "Счёт", sortValue: (l) => l.invoice_no ?? "", render: (_, l) => l.invoice_no ?? "" },
          ...(hasOptions
            ? [
                {
                  key: "options",
                  title: "Исполнение",
                  render: (_: unknown, l: OrderLine) => (
                    <LineOptions
                      compact
                      options={l.options}
                      fields={l.option_fields}
                      onSave={
                        canManage
                          ? async (next) => {
                              try {
                                await saveOrderLineOptions(order, l, next);
                                qc.invalidateQueries({ queryKey: ["production-order", order.id] });
                                message.success("Исполнение сохранено");
                              } catch (e) {
                                message.error(apiErrorMessage(e, "Не удалось сохранить"));
                                throw e;
                              }
                            }
                          : undefined
                      }
                    />
                  ),
                },
              ]
            : []),
          { key: "note", title: "Примечание", sortValue: (l) => l.note ?? "", render: (_, l) => l.note ?? "" },
          {
            key: "route",
            title: "Маршрут",
            sortValue: routeOf,
            render: (_, l) =>
              l.operations.length ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {l.operations.map((o) => o.name).join(" → ")}
                </Typography.Text>
              ) : l.without_route ? (
                <Tag title="Без этапов: в работе с запуска, готово — отметкой на вкладке «Ход»">без этапов</Tag>
              ) : (
                <Tag color="red">нет маршрута</Tag>
              ),
          },
        ]}
      />
    </Space>
  );
}
