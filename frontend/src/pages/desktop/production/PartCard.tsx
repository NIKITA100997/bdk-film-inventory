import { useLocation, useNavigate } from "react-router-dom";
import { Card, Space, Typography, Table, Tag, Empty, Button } from "antd";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { useQueries, useQuery } from "@tanstack/react-query";
import { listPartUnits, listPartUnitEvents, type PartUnit, type PartUnitEvent } from "../../../api/partUnits";
import { listParts, listAllMaterialSkus } from "../../../api/dictionaries";
import { listProductModels } from "../../../api/production";
import { listAreas } from "../../../api/areas";
import { listUsers } from "../../../api/users";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { skuLabel } from "../../../api/units";

const STATUS_LABEL: Record<string, string> = {
  На_хранении: "На хранении",
  Выдан_участку: "Выдан участку",
  Списан: "Списан",
};
const STATUS_TAG_COLOR: Record<string, string> = {
  На_хранении: "blue",
  Выдан_участку: "green",
  Списан: "red",
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
  const stageNames = [...new Set(units.map((u) => u.stage_name))];

  const eventsByUnit = useQueries({
    queries: units.map((u) => ({ queryKey: ["part-unit-events", u.id], queryFn: () => listPartUnitEvents(u.id) })),
  });
  const stageName = (id: number | null) => (id == null ? null : part?.stages.find((s) => s.id === id)?.name ?? `#${id}`);
  const allEvents: (PartUnitEvent & { unitId: number })[] = units.flatMap((u, i) =>
    (eventsByUnit[i]?.data ?? []).map((ev) => ({ ...ev, unitId: u.id })),
  );
  allEvents.sort((a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime());

  const totalAvailable = units.reduce((sum, u) => sum + u.quantity_available, 0);
  const byStage = stageNames.map((sn) => ({
    stageName: sn,
    qty: units.filter((u) => u.stage_name === sn).reduce((sum, u) => sum + u.quantity_available, 0),
  }));

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
                <Tag key={s.stageName} style={{ margin: 0 }}>
                  {s.stageName}: {Math.round(s.qty * 100) / 100}
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

      <Card title={`Партии (${units.length})`}>
        <ResponsiveTable<PartUnit>
          tableKey="part-card-units"
          lockedColumns={["№"]}
          size="small"
          tableLayout="fixed"
          rowKey="id"
          loading={unitsQuery.isLoading}
          dataSource={units}
          pagination={{ pageSize: 10 }}
          onRow={(u) => ({ onClick: () => navigate("/part-units", { state: { openUnitId: u.id } }), style: { cursor: "pointer" } })}
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
    </Space>
  );
}
