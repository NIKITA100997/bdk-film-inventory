import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Card, Space, Typography, Table, Tag, Empty, Button, Modal, Checkbox, InputNumber, message, Segmented, Select, Form, Input, Alert } from "antd";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  advancePartUnit,
  writeOffPartUnit,
  returnPartUnit,
  adjustPartUnit,
  listPartUnits,
  listPartUnitEvents,
  type PartUnit,
  type PartUnitEvent,
} from "../../../api/partUnits";
import { placePartUnit } from "../../../api/partStorage";
import { listParts, listAllMaterialSkus } from "../../../api/dictionaries";
import { listProductModels } from "../../../api/production";
import { listAreas } from "../../../api/areas";
import { listUsers } from "../../../api/users";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { skuLabel } from "../../../api/units";
import { useAuth } from "../../../auth/AuthContext";
import OccurredAtField from "../../../components/OccurredAtField";
import { toOccurredAtIso } from "../../../utils/occurredAt";
import type { Dayjs } from "dayjs";

const STATUS_LABEL: Record<string, string> = {
  На_хранении: "На хранении",
  Выдан_участку: "Выдан участку",
  Списан: "Списан",
  В_переработку: "В переработку",
};
const STATUS_TAG_COLOR: Record<string, string> = {
  На_хранении: "blue",
  Выдан_участку: "green",
  Списан: "red",
  В_переработку: "purple",
};

/** Карточка детали п/ф (раздел про переработку вкладок остатков/
 * стеллажей) — зеркалит карточку материала у плёнки: остаток, привязки
 * (к каким моделям дверей и какая плёнка закреплена), список партий и
 * общая история по ВСЕМ им сразу (не по одной партии за раз, как
 * "карточка партии" в PartUnits.tsx). Не пункт меню — открывается кликом
 * по строке в "Остатки п/ф" (тот же приём, что карточка материала). */
export default function PartCard() {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("part_units.manage");
  // Раздел про "действия надо добавить в карточку детали" — то же узкое
  // право, что уже отдельно от part_units.manage в "Учёт п/ф" (Вернуть на
  // склад/Скорректировать — обычно только админ/начальник склада).
  const canCorrect = !!user?.is_superuser || !!user?.permissions.includes("part_units.correct");
  const partId = (location.state as { partId?: number } | null)?.partId;

  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const part = partsQuery.data?.find((p) => p.id === partId);
  const unitsQuery = useQuery({
    queryKey: ["part-units", "part", partId],
    queryFn: () => listPartUnits({ part_id: partId }),
    enabled: !!partId,
  });
  const skusQuery = useQuery({ queryKey: ["material-skus", "all"], queryFn: listAllMaterialSkus });
  const modelsQuery = useQuery({ queryKey: ["product-models"], queryFn: listProductModels });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const usersQuery = useQuery({ queryKey: ["users"], queryFn: listUsers });
  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", "parts"], queryFn: () => listWriteOffReasons("parts") });

  const areaLabel = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "—");
  const userName = (id: number) => usersQuery.data?.find((u) => u.id === id)?.full_name ?? `#${id}`;

  const units = unitsQuery.data ?? [];
  const stageIds = [...new Set(units.map((u) => u.stage_id))];

  const eventsByUnit = useQueries({
    queries: units.map((u) => ({ queryKey: ["part-unit-events", u.id], queryFn: () => listPartUnitEvents(u.id) })),
  });
  const stageName = (id: number | null) => (id == null ? null : part?.stages.find((s) => s.id === id)?.name ?? `#${id}`);
  const allEvents: (PartUnitEvent & { unitId: number })[] = units.flatMap((u, i) =>
    (eventsByUnit[i]?.data ?? []).map((ev) => ({ ...ev, unitId: u.id })),
  );
  allEvents.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

  const totalAvailable = units.reduce((sum, u) => sum + u.quantity_available, 0);
  // stageId вместо имени — по нему, а не по строке, ищем следующий этап
  // маршрута (sequence_order) для быстрого действия "Перевести".
  const byStage = stageIds.map((stageId) => {
    const stageUnits = units.filter((u) => u.stage_id === stageId);
    return {
      stageId,
      stageName: stageUnits[0]?.stage_name ?? `#${stageId}`,
      qty: stageUnits.reduce((sum, u) => sum + u.quantity_available, 0),
    };
  });
  const nextStageOf = (stageId: number) => {
    if (!part) return null;
    const stages = [...part.stages].sort((a, b) => a.sequence_order - b.sequence_order);
    const idx = stages.findIndex((s) => s.id === stageId);
    if (idx === -1 || idx + 1 >= stages.length) return null;
    return stages[idx + 1];
  };

  // Раздел про удобство работы мастера участка п/ф — быстрый перевод
  // партий на следующий этап прямо с карточки детали (сводка "по
  // этапам"), не через отдельный журнал "Учёт п/ф". Мастеру важно самому
  // видеть и выбирать, какая именно партия/дата изготовления двигается
  // (не слепой FIFO) — модалка со списком партий ИМЕННО этого этапа,
  // отмеченных участку, с редактируемым количеством у каждой; итоговое
  // перемещённое количество может складываться из нескольких партий
  // сразу — они просто переводятся каждая своим вызовом того же
  // advancePartUnit, что и при переводе одной партии.
  const [advanceTarget, setAdvanceTarget] = useState<{ stageId: number; stageName: string } | null>(null);
  const [advanceQty, setAdvanceQty] = useState<Record<number, number | null>>({});
  const advanceRows = advanceTarget
    ? units
        .filter((u) => u.stage_id === advanceTarget.stageId && u.status === "Выдан_участку" && u.quantity_available > 0)
        .sort((a, b) => a.manufactured_at.localeCompare(b.manufactured_at))
    : [];
  const advanceNextStage = advanceTarget ? nextStageOf(advanceTarget.stageId) : null;
  const advanceTotal = Object.values(advanceQty).reduce((sum: number, v) => sum + (v ?? 0), 0);
  const advanceMutation = useMutation({
    mutationFn: async () => {
      for (const u of advanceRows) {
        const qty = advanceQty[u.id];
        if (qty && qty > 0) await advancePartUnit(u.id, qty);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units", "part", partId] });
      message.success(
        advanceNextStage
          ? `Переведено ${Math.round(advanceTotal * 100) / 100} шт на этап «${advanceNextStage.name}»`
          : `Отмечено завершение для ${Math.round(advanceTotal * 100) / 100} шт`,
      );
      setAdvanceTarget(null);
      setAdvanceQty({});
    },
    onError: () => message.error("Не удалось перевести — проверьте количества по каждой партии"),
  });

  // Раздел про "партии внутри карточки" — мастеру важнее всего кол-во и
  // на каком участке/этапе оно находится, разграничение внутри (по
  // статусу/этапу/участку) — уже здесь, без отдельного захода в "Учёт
  // п/ф" (тот остаётся плоским журналом для сквозного поиска по всем
  // деталям, не рабочим экраном одной детали).
  const [partiiStatusFilter, setPartiiStatusFilter] = useState<string | undefined>(undefined);
  const [partiiStageFilter, setPartiiStageFilter] = useState<number | undefined>(undefined);
  const [partiiAreaFilter, setPartiiAreaFilter] = useState<string | undefined>(undefined);
  const [hideFullyUsed, setHideFullyUsed] = useState(true);
  const partiiAreaOptions = [...new Set(units.map((u) => u.area).filter((a): a is string => !!a))].map((a) => ({
    value: a,
    label: areaLabel(a),
  }));
  const filteredUnits = units.filter((u) => {
    // Раздел про "зачем указывать списание среди партий" — списание не
    // добавляет партию, это действие НАД ней (видно в "Истории" ниже), а
    // не остаток. По умолчанию (статус не выбран явно) списанные партии
    // тут не показываются вовсе — иначе за ними не видно, сколько реально
    // осталось от живых партий. Выбрать статус "Списан" явно в
    // переключателе — можно, тогда видно именно их (это уже осознанный
    // просмотр истории списаний, не остаток).
    if (partiiStatusFilter) {
      if (u.status !== partiiStatusFilter) return false;
    } else if (u.status === "Списан") {
      return false;
    }
    if (partiiStageFilter && u.stage_id !== partiiStageFilter) return false;
    if (partiiAreaFilter && u.area !== partiiAreaFilter) return false;
    if (hideFullyUsed && u.quantity_available <= 0 && u.status !== "Списан") return false;
    return true;
  });

  // Раздел про "действия надо добавить в карточку детали" — те же 4
  // быстрых действия на физическую единицу, что уже есть на карточке
  // материала (MaterialCard.tsx: Скорректировать/Списать/Разместить/
  // Вернуть), прямо в таблице "Партии", без захода в мобильную карточку
  // партии.
  const [adjustTarget, setAdjustTarget] = useState<PartUnit | null>(null);
  const [writeOffTarget, setWriteOffTarget] = useState<PartUnit | null>(null);
  const [placeTarget, setPlaceTarget] = useState<PartUnit | null>(null);
  const [returnTarget, setReturnTarget] = useState<PartUnit | null>(null);

  const defaultSku = part?.default_material_sku_id != null ? skusQuery.data?.find((s) => s.id === part.default_material_sku_id) : null;
  const bomLines = (modelsQuery.data ?? []).flatMap((m) =>
    m.parts.filter((p) => p.part_name === part?.name).map((p) => ({ model: m, line: p })),
  );

  if (!partId) {
    return (
      <Card>
        <Empty description="Деталь не выбрана — откройте карточку кликом по строке в «Остатки п/ф»" />
      </Card>
    );
  }

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card loading={partsQuery.isLoading}>
        {/* Раздел про адаптацию под смартфон — обычный Card title/extra
         * не переносит строку на узких экранах и обрезает многоточием
         * длинное название детали (единственный способ мастеру
         * убедиться, что это нужная деталь). Свой заголовок с
         * flexWrap вместо этого. */}
        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 16 }}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            {part ? `Деталь «${part.name}»` : "Деталь"}
          </Typography.Title>
          <Button onClick={() => navigate("/part-stock")}>← К остаткам</Button>
        </div>
        {part && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, fontSize: 13 }}>
            <div>
              <Typography.Text type="secondary">Размер</Typography.Text>
              <div>
                <b>{part.width_mm} × {part.length_m} м</b>
                {part.strip_width_mm != null && <span> (штрипс {part.strip_width_mm} мм)</span>}
              </div>
            </div>
            <div>
              <Typography.Text type="secondary">Участок (справочник)</Typography.Text>
              <div><b>{part.area ? areaLabel(part.area) : "—"}</b></div>
            </div>
            <div>
              <Typography.Text type="secondary">Маршрут этапов</Typography.Text>
              <div>
                {part.stages.length > 0
                  ? [...part.stages].sort((a, b) => a.sequence_order - b.sequence_order).map((s) => s.name).join(" → ")
                  : "не настроен"}
              </div>
            </div>
            <div>
              <Typography.Text type="secondary">Доступно всего</Typography.Text>
              <div><b>{Math.round(totalAvailable * 100) / 100} шт</b></div>
            </div>
          </div>
        )}
        {byStage.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <Space size={4} wrap>
              {byStage.map((s) => (
                <Tag key={s.stageId} style={{ margin: 0 }}>
                  {s.stageName}: {Math.round(s.qty * 100) / 100}
                  {canManage && (
                    <a
                      style={{ marginLeft: 8 }}
                      onClick={() => {
                        setAdvanceTarget({ stageId: s.stageId, stageName: s.stageName });
                        setAdvanceQty({});
                      }}
                    >
                      Перевести →
                    </a>
                  )}
                </Tag>
              ))}
            </Space>
          </div>
        )}
      </Card>

      <Card title="Привязки по плёнке">
        {defaultSku && (
          <Typography.Paragraph>
            <Tag color="purple">🔒 закреплено</Tag> {skuLabel(defaultSku)}
          </Typography.Paragraph>
        )}
        {bomLines.length === 0 ? (
          <Typography.Text type="secondary">Не встречается в BOM ни одной модели продукции.</Typography.Text>
        ) : (
          <Table
            size="small"
            rowKey={(r) => `${r.model.id}-${r.line.id}`}
            pagination={false}
            dataSource={bomLines}
            columns={[
              { title: "Модель", render: (_, r) => r.model.name },
              { title: "Участок", render: (_, r) => areaLabel(r.line.area) },
              { title: "Шт. на изделие", dataIndex: ["line", "qty_per_unit"] },
              { title: "Размер плёнки", render: (_, r) => `${r.line.width_mm} × ${r.line.length_m} м` },
              { title: "Ширина штрипса", render: (_, r) => (r.line.strip_width_mm != null ? `${r.line.strip_width_mm} мм` : "—") },
            ]}
          />
        )}
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12.5 }}>
          BOM модели не фиксирует конкретный материал/цвет плёнки — это выбирается при создании каждого задания.
          {!defaultSku && " Закрепить конкретную плёнку за деталью можно в «Детали (справочник)»."}
        </Typography.Paragraph>
      </Card>

      <Card title={`Партии (${filteredUnits.length} из ${units.length})`}>
        <Space wrap size={[12, 12]} style={{ marginBottom: 16, width: "100%" }}>
          <Segmented
            value={partiiStatusFilter ?? "all"}
            onChange={(v) => setPartiiStatusFilter(v === "all" ? undefined : (v as string))}
            options={[
              { label: "Все", value: "all" },
              { label: "На хранении", value: "На_хранении" },
              { label: "Выдан участку", value: "Выдан_участку" },
              { label: "Списан", value: "Списан" },
              { label: "В переработку", value: "В_переработку" },
            ]}
          />
          <Select
            allowClear
            placeholder="Все этапы"
            style={{ width: 200 }}
            value={partiiStageFilter}
            onChange={setPartiiStageFilter}
            options={[...(part?.stages ?? [])]
              .sort((a, b) => a.sequence_order - b.sequence_order)
              .map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            allowClear
            placeholder="Все участки"
            style={{ width: 220 }}
            value={partiiAreaFilter}
            onChange={setPartiiAreaFilter}
            options={partiiAreaOptions}
          />
          <Checkbox checked={hideFullyUsed} onChange={(e) => setHideFullyUsed(e.target.checked)}>
            Скрыть полностью использованные (0 доступно)
          </Checkbox>
        </Space>
        <ResponsiveTable<PartUnit>
          tableKey="part-card-units"
          lockedColumns={["№"]}
          size="small"
          tableLayout="fixed"
          rowKey="id"
          loading={unitsQuery.isLoading}
          dataSource={filteredUnits}
          locale={{ emptyText: "Ничего не найдено по текущему фильтру" }}
          pagination={{ pageSize: 10 }}
          // Раздел про "нельзя открыть партию отдельно" — раньше клик вёл в
          // "Учёт п/ф" на read-only модалку (только цифры и история, без
          // единой кнопки действия). "Карточка партии п/ф" (PartUnitCard.tsx)
          // — тот же экран, что сканер на телефоне, с реальными действиями
          // (перевести на этап/списать/разместить/скорректировать), и уже
          // умеет открываться сразу с готовым unitId (см. её useEffect).
          onRow={(u) => ({ onClick: () => navigate("/m/part-unit-card", { state: { unitId: u.id } }), style: { cursor: "pointer" } })}
          columns={[
            { title: "№", dataIndex: "id", width: 70 },
            {
              title: "Кол-во",
              width: 110,
              render: (_, u) => (
                <>
                  {u.quantity_available}
                  {u.quantity_available !== u.quantity_pieces && (
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}> из {u.quantity_pieces}</Typography.Text>
                  )}
                </>
              ),
            },
            { title: "Этап", dataIndex: "stage_name" },
            { title: "Статус", render: (_, u) => <Tag color={STATUS_TAG_COLOR[u.status]}>{STATUS_LABEL[u.status]}</Tag> },
            { title: "Участок", render: (_, u) => areaLabel(u.area) },
            { title: "Место", render: (_, u) => u.location_code ?? "—" },
            { title: "Изготовлено", dataIndex: "manufactured_at", render: (v: string) => new Date(v).toLocaleDateString("ru-RU") },
            {
              title: "",
              width: 210,
              render: (_, u) => (
                <Space size={4} wrap onClick={(e) => e.stopPropagation()}>
                  {canManage && u.status !== "Списан" && (
                    <Button size="small" onClick={() => setPlaceTarget(u)}>
                      Разместить
                    </Button>
                  )}
                  {canCorrect && u.status === "Выдан_участку" && (
                    <Button size="small" onClick={() => setReturnTarget(u)}>
                      Вернуть
                    </Button>
                  )}
                  {canCorrect && (
                    <Button size="small" onClick={() => setAdjustTarget(u)}>
                      Скорректировать
                    </Button>
                  )}
                  {canManage && u.status !== "Списан" && (
                    <Button size="small" danger onClick={() => setWriteOffTarget(u)}>
                      Списать
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card title="История (все партии этой детали)">
        {allEvents.length === 0 ? (
          <Typography.Text type="secondary">Событий пока нет.</Typography.Text>
        ) : (
          <Space direction="vertical" size={0} style={{ width: "100%" }}>
            {allEvents.map((ev, i) => (
              <div
                key={ev.id}
                style={{ display: "flex", gap: 10, padding: "10px 0", borderTop: i === 0 ? "none" : "1px solid #DEDEDA", fontSize: 13 }}
              >
                <Tag style={{ margin: 0, flexShrink: 0, height: "fit-content" }}>№{ev.unitId}</Tag>
                <Tag style={{ margin: 0, flexShrink: 0, height: "fit-content" }}>{ev.event_type.replace(/_/g, " ")}</Tag>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>
                    {ev.quantity_delta > 0 ? "+" : ""}
                    {ev.quantity_delta} шт
                    {ev.from_stage_id != null && ev.to_stage_id != null && (
                      <> · {stageName(ev.from_stage_id)} → {stageName(ev.to_stage_id)}</>
                    )}
                    {ev.to_cell && <> · {ev.from_cell ? `${ev.from_cell} → ${ev.to_cell}` : ev.to_cell}</>}
                    {ev.area && <> · {areaLabel(ev.area)}</>}
                    {ev.write_off_reason && (
                      <> · причина: {reasonsQuery.data?.find((r) => r.code === ev.write_off_reason)?.name ?? ev.write_off_reason}</>
                    )}
                  </div>
                  {ev.note && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {ev.note}
                    </Typography.Text>
                  )}
                  <div style={{ fontSize: 11.5, color: "#8A8C99" }}>
                    {new Date(ev.occurred_at).toLocaleString("ru-RU")} — {userName(ev.user_id)}
                  </div>
                </div>
              </div>
            ))}
          </Space>
        )}
      </Card>

      <Modal
        title={
          advanceTarget &&
          (advanceNextStage
            ? `Перевести «${part?.name}» с этапа «${advanceTarget.stageName}» на «${advanceNextStage.name}»`
            : `Завершение этапа «${advanceTarget.stageName}»`)
        }
        open={!!advanceTarget}
        onCancel={() => {
          setAdvanceTarget(null);
          setAdvanceQty({});
        }}
        footer={null}
        destroyOnHidden
        width={560}
      >
        {advanceRows.length === 0 ? (
          <Typography.Text type="secondary">На этом этапе нет партий, выданных участку.</Typography.Text>
        ) : (
          <Space direction="vertical" style={{ width: "100%" }} size="middle">
            <Typography.Text type="secondary">
              Отметьте партии и при необходимости поправьте количество — можно перевести сразу несколько партий одним
              действием.
            </Typography.Text>
            <Space direction="vertical" style={{ width: "100%" }} size={4}>
              {advanceRows.map((u) => {
                const checked = advanceQty[u.id] != null;
                return (
                  <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid #EAE8E2" }}>
                    <Checkbox
                      checked={checked}
                      onChange={(e) =>
                        setAdvanceQty((prev) => ({ ...prev, [u.id]: e.target.checked ? u.quantity_available : null }))
                      }
                    />
                    <div style={{ flex: 1 }}>
                      <div>
                        №{u.id} · {new Date(u.manufactured_at).toLocaleDateString("ru-RU")}
                        {u.location_code && <> · {u.location_code}</>}
                      </div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        доступно {u.quantity_available} шт
                      </Typography.Text>
                    </div>
                    <InputNumber
                      min={0.01}
                      max={u.quantity_available}
                      disabled={!checked}
                      value={advanceQty[u.id] ?? u.quantity_available}
                      onChange={(v) => setAdvanceQty((prev) => ({ ...prev, [u.id]: v }))}
                      style={{ width: 100 }}
                    />
                  </div>
                );
              })}
            </Space>
            <Button
              type="primary"
              block
              disabled={advanceTotal <= 0}
              loading={advanceMutation.isPending}
              onClick={() => advanceMutation.mutate()}
            >
              {advanceNextStage ? `Перевести ${Math.round(advanceTotal * 100) / 100} шт` : `Завершить ${Math.round(advanceTotal * 100) / 100} шт`}
            </Button>
          </Space>
        )}
      </Modal>

      {placeTarget && <PartUnitPlaceModal unit={placeTarget} onClose={() => setPlaceTarget(null)} />}
      {returnTarget && <PartUnitReturnModal unit={returnTarget} onClose={() => setReturnTarget(null)} />}
      {adjustTarget && <PartUnitAdjustModal unit={adjustTarget} onClose={() => setAdjustTarget(null)} />}
      {writeOffTarget && <PartUnitWriteOffModal unit={writeOffTarget} onClose={() => setWriteOffTarget(null)} />}
    </Space>
  );
}

/** Раздел про "действия надо добавить в карточку детали" — те же 4
 * быстрых действия на физическую единицу, что уже есть на карточке
 * материала (MaterialCard.tsx), как модалки по клику в таблице "Партии"
 * этой карточки. */
function PartUnitPlaceModal({ unit, onClose }: { unit: PartUnit; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ location_code: string; occurred_at?: Dayjs | null }>();

  const placeMutation = useMutation({
    mutationFn: (v: { location_code: string; occurred_at?: Dayjs | null }) =>
      placePartUnit(unit.id, v.location_code, toOccurredAtIso(v.occurred_at)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success(`Партия №${unit.id} размещена`);
      onClose();
    },
    onError: () => message.error("Не удалось разместить партию"),
  });

  return (
    <Modal title={`Разместить — партия №${unit.id}`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ location_code: unit.location_code ?? undefined }}
        onFinish={(v) => placeMutation.mutate(v)}
      >
        <Form.Item name="location_code" label="Адрес ячейки" rules={[{ required: true }]}>
          <Input placeholder="Например, ЗГ-1-04" />
        </Form.Item>
        <OccurredAtField />
        <Button type="primary" htmlType="submit" block loading={placeMutation.isPending}>
          Сохранить адрес
        </Button>
      </Form>
    </Modal>
  );
}

function PartUnitReturnModal({ unit, onClose }: { unit: PartUnit; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ actual_quantity_pieces: number; occurred_at?: Dayjs | null }>();

  const returnMutation = useMutation({
    mutationFn: (v: { actual_quantity_pieces: number; occurred_at?: Dayjs | null }) =>
      returnPartUnit(unit.id, v.actual_quantity_pieces, toOccurredAtIso(v.occurred_at)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success(`Партия №${unit.id} возвращена на склад`);
      onClose();
    },
    onError: () => message.error("Не удалось оформить возврат"),
  });

  return (
    <Modal title={`Вернуть на склад — партия №${unit.id}`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Выдано было {unit.quantity_pieces} шт, доступно к возврату {unit.quantity_available} шт.
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ actual_quantity_pieces: unit.quantity_available }}
        onFinish={(v) => returnMutation.mutate(v)}
      >
        <Form.Item name="actual_quantity_pieces" label="Фактически возвращается, шт" rules={[{ required: true }]}>
          <InputNumber min={0} max={unit.quantity_available} style={{ width: "100%" }} />
        </Form.Item>
        <OccurredAtField />
        <Button type="primary" htmlType="submit" block loading={returnMutation.isPending}>
          Вернуть на склад
        </Button>
      </Form>
    </Modal>
  );
}

function PartUnitAdjustModal({ unit, onClose }: { unit: PartUnit; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ actual_quantity_pieces: number; reason: string; note?: string; occurred_at?: Dayjs | null }>();

  const adjustMutation = useMutation({
    mutationFn: (v: { actual_quantity_pieces: number; reason: string; note?: string; occurred_at?: Dayjs | null }) =>
      adjustPartUnit(unit.id, { ...v, occurred_at: toOccurredAtIso(v.occurred_at) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success(`Партия №${unit.id} скорректирована`);
      onClose();
    },
    onError: () => message.error("Не удалось скорректировать"),
  });

  return (
    <Modal title={`Скорректировать — партия №${unit.id}`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Сейчас в системе {unit.quantity_pieces} шт. Формальная правка вместо изменения истории напрямую — действие
        добавит запись в журнал партии, причина обязательна.
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ actual_quantity_pieces: unit.quantity_pieces }}
        onFinish={(v) => adjustMutation.mutate(v)}
      >
        <Form.Item name="actual_quantity_pieces" label="Фактическое количество, шт" rules={[{ required: true }]}>
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="reason" label="Причина" rules={[{ required: true, message: "Укажите причину корректировки" }]}>
          <Input placeholder="Например: опечатка при вводе" />
        </Form.Item>
        <Form.Item name="note" label="Заметка (опционально)">
          <Input.TextArea rows={2} />
        </Form.Item>
        <OccurredAtField />
        <Button type="primary" htmlType="submit" block loading={adjustMutation.isPending}>
          Скорректировать
        </Button>
      </Form>
    </Modal>
  );
}

function PartUnitWriteOffModal({ unit, onClose }: { unit: PartUnit; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ quantity_pieces: number; reason: string; note?: string; occurred_at?: Dayjs | null }>();
  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", "parts"], queryFn: () => listWriteOffReasons("parts") });

  const writeOffMutation = useMutation({
    mutationFn: (v: { quantity_pieces: number; reason: string; note?: string; occurred_at?: Dayjs | null }) =>
      writeOffPartUnit(unit.id, { ...v, occurred_at: toOccurredAtIso(v.occurred_at) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success(`Партия №${unit.id} списана`);
      onClose();
    },
    onError: () => message.error("Не удалось списать"),
  });

  return (
    <Modal title={`Списать — партия №${unit.id}`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Alert
        style={{ marginBottom: 16 }}
        type="warning"
        showIcon
        message="Отменить нельзя — используйте, если партия испорчена или физически отсутствует."
      />
      <Form
        form={form}
        layout="vertical"
        initialValues={{ quantity_pieces: unit.quantity_available }}
        onFinish={(v) => writeOffMutation.mutate(v)}
      >
        <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
          <InputNumber min={0.01} max={unit.quantity_available} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
          <Select loading={reasonsQuery.isLoading} options={(reasonsQuery.data ?? []).map((r) => ({ value: r.code, label: r.name }))} />
        </Form.Item>
        <Form.Item name="note" label="Заметка (опционально)">
          <Input.TextArea rows={2} />
        </Form.Item>
        <OccurredAtField />
        <Button type="primary" danger htmlType="submit" block loading={writeOffMutation.isPending}>
          Списать
        </Button>
      </Form>
    </Modal>
  );
}
