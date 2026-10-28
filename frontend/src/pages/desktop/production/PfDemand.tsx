import { useEffect, useMemo, useState } from "react";
import ShortageTags from "../../../components/ShortageTags";
import { PfFilterBar, PfSections } from "../../../components/PfGrouping";
import { filterPf, sectionsPf, usePfFilter, usePfIndex } from "../../../components/pfGroupingState";
import dayjs, { type Dayjs } from "dayjs";
import { useNavigate } from "react-router-dom";
import { DatePicker, Button, Card, Checkbox, Form, InputNumber, Modal, Select, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { useAuth } from "../../../auth/AuthContext";
import { listAreas } from "../../../api/areas";
import { listParts } from "../../../api/dictionaries";
import { setNormatives } from "../../../api/items";
import { createPfTasks, listPfDemand, suggestLaminationArea, type PfDemandRow } from "../../../api/pfDemand";
import LaminationAreaSelect from "../../../components/LaminationAreaSelect";
import { apiErrorMessage } from "../../../utils/apiError";
import { normsLabel } from "../../../utils/normatives";
import { hasPerm } from "../../../auth/permissions";

const fmt = (n: number) => Math.round(n * 100) / 100;

/** Потребность п/ф — сколько деталей надо произвести, чтобы закрыть открытые
 * задания цеха и держать минимальный остаток; предложение округляется вверх
 * до минимальной партии. «Создать задания» отправляет их участку первого
 * этапа каждой детали (Задания участков). */
export default function PfDemand() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = hasPerm(user, "production_tasks.manage");
  const [onlyShortage, setOnlyShortage] = useState(true);
  // Мастер участка: по умолчанию — только детали, у которых в маршруте
  // есть операция на его участке (что делать ему).
  const [onlyMine, setOnlyMine] = useState(!!user?.area);
  const [qty, setQty] = useState<Record<number, number | null>>({});
  // Срок нового заказа на п/ф — от него считаются сроки операций.
  const [dueDate, setDueDate] = useState<Dayjs | null>(null);
  // Площадка ламинации панели, выбранная вручную (иначе — по размеру партии).
  const [lamArea, setLamArea] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<number[]>([]);
  const [editTarget, setEditTarget] = useState<PfDemandRow | null>(null);
  const [taskFilter, setTaskFilter] = useState<number[]>([]);
  // Направление / группа / стадия из номенклатуры и разбивка по группам.
  const [pf, setPf] = usePfFilter();
  const { byPart: pfAttrs, groups: itemGroups } = usePfIndex();

  // Варианты фильтра — задания цеха из общего расчёта (без фильтра); при
  // пустом фильтре это тот же запрос, что и таблица.
  const allQuery = useQuery({ queryKey: ["pf-demand", []], queryFn: () => listPfDemand([]) });
  const demandQuery = useQuery({ queryKey: ["pf-demand", taskFilter], queryFn: () => listPfDemand(taskFilter) });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts, enabled: !!user?.area });
  const myParts = useMemo(
    () => new Set((partsQuery.data ?? []).filter((p) => p.stages.some((st) => st.area === user?.area)).map((p) => p.id)),
    [partsQuery.data, user?.area],
  );
  const areaName = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : null);

  const rows = useMemo(
    () =>
      filterPf(
        (demandQuery.data ?? [])
          .filter((r) => !onlyShortage || r.shortage > 0)
          .filter((r) => !onlyMine || !user?.area || myParts.has(r.part_id)),
        (r) => r.part_id,
        pf,
        pfAttrs,
        itemGroups,
      ),
    [demandQuery.data, onlyShortage, onlyMine, myParts, user?.area, pf, pfAttrs, itemGroups],
  );
  const sections = sectionsPf(rows, (r) => r.part_id, pf, pfAttrs, itemGroups);

  // Задания для отбора (28.10) — только те, которым нужны детали из текущей
  // выборки (у мастера — своего участка), а не все задания завода; по
  // нехватке: самые нужные — метками над таблицей, остальные — в списке.
  const taskStats = useMemo(() => {
    const base = filterPf(
      (allQuery.data ?? [])
        .filter((r) => !onlyShortage || r.shortage > 0)
        .filter((r) => !onlyMine || !user?.area || myParts.has(r.part_id)),
      (r) => r.part_id,
      pf,
      pfAttrs,
      itemGroups,
    );
    const by = new Map<number, { id: number; name: string; parts: number; shortage: number }>();
    for (const r of base)
      for (const src of r.sources) {
        const t = by.get(src.task_id) ?? { id: src.task_id, name: src.task_name, parts: 0, shortage: 0 };
        t.parts += 1;
        t.shortage += src.shortage;
        by.set(src.task_id, t);
      }
    return [...by.values()].sort((a, b) => b.shortage - a.shortage || b.parts - a.parts || a.id - b.id);
  }, [allQuery.data, onlyShortage, onlyMine, user?.area, myParts, pf, pfAttrs, itemGroups]);
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
        items: toCreate
          .map((id) => {
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

  // Только отмеченное среди видимого (отборы могли скрыть часть строк).
  const visible = new Set(rows.map((r) => r.part_id));
  const toCreate = selected.filter((id) => visible.has(id) && (qty[id] ?? 0) > 0);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Детали п/ф: сколько произвести"
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
        <Typography.Paragraph type="secondary">
          Нужно = остаток плана по открытым заданиям цеха и заказам на производство (комплектующие по составу) +
          минимальный остаток. Есть = все живые партии детали + уже запущенное в работу. В резерве — остаток,
          закреплённый за заданиями цеха (кнопка «Обеспечение п/ф» у задания), свободно — остальное. К производству — нехватка, но
          не меньше минимальной партии и вверх до кратного. Задания уходят на участки всех операций маршрута детали.
        </Typography.Paragraph>
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
          <Checkbox checked={onlyShortage} onChange={(e) => setOnlyShortage(e.target.checked)}>
            Только с нехваткой
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
              {onlyMine && user?.area ? "Задания, которым нужны детали вашего участка:" : "Задания с нехваткой п/ф:"}
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
        {taskFilter.length > 0 && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            Только выбранные задания: «Нужно» — их остаток без минимального остатка детали. «Есть» — свободный остаток
            плюс резерв этих заданий, «В работе» — производимое под эти задания плюс запущенное без привязки.
          </Typography.Paragraph>
        )}
      </Card>

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
        locale={{ emptyText: onlyShortage ? "Нехватки нет" : "Нет деталей с минимальным остатком или потребностью" }}
        expandable={{
          rowExpandable: (r) => r.sources.length > 0,
          expandedRowRender: (r) => (
            <div style={{ padding: "4px 0" }}>
              <Typography.Text type="secondary">
                Откуда «по заданиям цеха»: остаток по заданию целиком (сделанное сверх плана одной строки закрывает
                соседние). Если задание уже сделано — закройте его в «Заданиях цеха», и оно уйдёт отсюда.
              </Typography.Text>
              <table style={{ marginTop: 8, borderCollapse: "collapse", width: "auto" }}>
                <thead>
                  <tr>
                    {["Задание цеха", "План", "Сделано", "Остаток", "Резерв", "Делается под задание", "Не хватает"].map((h) => (
                      <th key={h} style={{ textAlign: "left", padding: "2px 16px 2px 0", fontWeight: 500 }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.sources.map((s) => (
                    <tr key={s.task_id}>
                      <td style={{ padding: "2px 16px 2px 0" }}>
                        №{s.task_id} · {s.task_name}
                      </td>
                      <td style={{ padding: "2px 16px 2px 0" }}>{fmt(s.open_plan)}</td>
                      <td style={{ padding: "2px 16px 2px 0" }}>{fmt(s.done)}</td>
                      <td style={{ padding: "2px 16px 2px 0" }}>
                        <b>{fmt(s.remaining)}</b>
                      </td>
                      <td style={{ padding: "2px 16px 2px 0" }}>{s.reserved > 0 ? fmt(s.reserved) : "—"}</td>
                      <td style={{ padding: "2px 16px 2px 0" }}>{s.in_work > 0 ? fmt(s.in_work) : "—"}</td>
                      <td style={{ padding: "2px 16px 2px 0" }}>
                        {s.shortage > 0 ? <Tag color="red">{fmt(s.shortage)}</Tag> : <Tag color="green">обеспечено</Tag>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ),
        }}
        rowSelection={
          canManage
            ? {
                selectedRowKeys: selected,
                // В секции — только её строки: отметки других групп не сбрасываются.
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
          { title: "Деталь", dataIndex: "part_name" },
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
          { title: "По заданиям цеха", render: (_, r) => fmt(r.task_demand) },
          { title: "Нужно", render: (_, r) => fmt(r.need) },
          { title: "Есть", render: (_, r) => fmt(r.stock) },
          {
            title: "В резерве / свободно",
            render: (_, r) => (
              <span>
                {fmt(r.reserved)} / <b>{fmt(r.free)}</b>
              </span>
            ),
          },
          { title: "В работе", render: (_, r) => fmt(r.in_work) },
          {
            title: "Не хватает",
            render: (_, r) => <ShortageTags total={r.shortage} tasks={r.shortage_tasks} min={r.shortage_min} />,
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
            title: "Ламинация",
            render: (_, r) => (
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
        )}
      />

      {editTarget && <MinValuesModal row={editTarget} onClose={() => setEditTarget(null)} />}
    </Space>
  );
}

type NormForm = { min_stock?: number | null; min_batch?: number | null; batch_multiple?: number | null };

/** Нормативы детали — у её позиции номенклатуры, как у плёнки и материалов
 * (08.10). */
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
