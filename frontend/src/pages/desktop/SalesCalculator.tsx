import { useState } from "react";
import { Card, Select, InputNumber, Space, Typography, Tag, Image, Empty, Row, Col, Button } from "antd";
import { PlusOutlined, DeleteOutlined, PictureOutlined } from "@ant-design/icons";
import Statistic from "../../components/Statistic";
import ResponsiveTable from "../../components/ResponsiveTable";
import { useQuery } from "@tanstack/react-query";
import { listMaterialSkus, getSkuAnalogs, skuPhotoUrl, type AnalogEntry } from "../../api/dictionaries";
import { skuLabel, type MaterialSku } from "../../api/units";
import { listProductModels, type ProductModel, type ProductModelPart } from "../../api/production";
import { getStockForSkus } from "../../api/purchasing";

function Photo({ sku, size = 48 }: { sku: MaterialSku; size?: number }) {
  const url = skuPhotoUrl(sku.photo_path);
  return url ? (
    <Image src={url} width={size} height={size} style={{ objectFit: "cover" }} />
  ) : (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f5f5f5",
        color: "#ccc",
      }}
    >
      <PictureOutlined style={{ fontSize: size / 2 }} />
    </div>
  );
}

/** Калькулятор заказа для продажника (8 раздел обратной связи) — выбирает
 * позицию, видит остаток и, если своей плёнки не хватает или есть более
 * ликвидная альтернатива, получает подсказку по аналогу из неликвида
 * (ручная привязка, «Аналоги/фото» в номенклатуре — 8.1). */
// Раздел про расход плёнки на заказ — площадь одной штрипс-полосы детали
// считаем по ширине штрипса под укутку (strip_width_mm), а не по ширине
// самой детали (width_mm) — это разные вещи (штрипс шире детали на запас
// на обёртывание), strip_width_mm может быть не задан для части BOM-строк
// (старые записи до правки в 5 разделе бэклога), тогда откатываемся на
// width_mm, как это уже сделано в Issue.tsx (`sw = strip_width_mm || width_mm`).
function partFilmAreaM2(part: ProductModelPart, orderQty: number): number {
  const stripWidthMm = part.strip_width_mm || part.width_mm;
  return (part.qty_per_unit * orderQty * stripWidthMm * part.length_m) / 1000;
}

interface OrderLine {
  key: string;
  modelId?: number;
  qty: number;
  skuId?: number;
  showParts: boolean;
}

function lineFilmTotalM2(model: ProductModel | undefined, qty: number): number {
  if (!model) return 0;
  return Math.round(model.parts.reduce((sum, p) => sum + partFilmAreaM2(p, qty), 0) * 100) / 100;
}

let nextLineKey = 1;

export default function SalesCalculator() {
  const [skuId, setSkuId] = useState<number | undefined>();
  const [neededM2, setNeededM2] = useState<number | undefined>();
  const [orderLines, setOrderLines] = useState<OrderLine[]>([{ key: "0", qty: 1, showParts: false }]);

  const modelsQuery = useQuery({ queryKey: ["product-models"], queryFn: listProductModels });
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });

  const modelsById = new Map((modelsQuery.data ?? []).map((m) => [m.id, m]));
  const skusById = new Map((skusQuery.data ?? []).map((s) => [s.id, s]));

  const addLine = () => setOrderLines((ls) => [...ls, { key: String(nextLineKey++), qty: 1, showParts: false }]);
  const removeLine = (key: string) => setOrderLines((ls) => ls.filter((l) => l.key !== key));
  const updateLine = (key: string, patch: Partial<OrderLine>) =>
    setOrderLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const linesComputed = orderLines.map((l) => {
    const model = l.modelId !== undefined ? modelsById.get(l.modelId) : undefined;
    return { ...l, model, totalM2: lineFilmTotalM2(model, l.qty) };
  });

  // Раздел про заказ из нескольких дверей/цветов — одна и та же плёнка
  // расходуется на все строки заказа этого цвета сразу, поэтому остаток/
  // резерв смотрим не по строке, а по позиции номенклатуры (skuId),
  // просуммировав расход всех строк этого цвета.
  const neededBySku = new Map<number, number>();
  for (const l of linesComputed) {
    if (l.skuId === undefined) continue;
    neededBySku.set(l.skuId, Math.round(((neededBySku.get(l.skuId) ?? 0) + l.totalM2) * 100) / 100);
  }
  const orderSkuIds = [...neededBySku.keys()];
  const stockForSkusQuery = useQuery({
    queryKey: ["stock-for-skus", orderSkuIds],
    queryFn: () => getStockForSkus(orderSkuIds),
    enabled: orderSkuIds.length > 0,
  });
  const stockBySku = new Map((stockForSkusQuery.data ?? []).map((s) => [s.sku_id, s]));
  const summaryRows = orderSkuIds.map((id) => {
    const needed = neededBySku.get(id) ?? 0;
    const stock = stockBySku.get(id);
    const available = stock?.available_area_m2 ?? 0;
    const shortage = Math.max(0, Math.round((needed - available) * 100) / 100);
    return { skuId: id, sku: skusById.get(id), needed, stock, shortage };
  });
  const analogsQuery = useQuery({
    queryKey: ["sku-analogs", skuId],
    queryFn: () => getSkuAnalogs(skuId!),
    enabled: !!skuId,
  });

  const sku = analogsQuery.data?.sku;
  const stock = analogsQuery.data?.stock_m2 ?? 0;
  const shortageM2 = neededM2 !== undefined ? Math.max(0, Math.round((neededM2 - stock) * 100) / 100) : null;
  const analogs = [...(analogsQuery.data?.analogs ?? [])].sort(
    (a, b) => Number(b.is_illiquid) - Number(a.is_illiquid),
  );

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Title level={4}>Калькулятор заказа</Typography.Title>

      <Typography.Title level={5} style={{ marginBottom: 0 }}>
        Расход плёнки на заказ
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        Заказ может быть из нескольких дверей разных моделей и цветов — добавьте по строке на каждую комбинацию
        модель+цвет. Внизу — итог по каждому использованному цвету: сколько нужно на этот заказ, сколько сейчас на
        складе, сколько уже зарезервировано под текущие задания цеха и сколько реально свободно.
      </Typography.Paragraph>

      <Space direction="vertical" style={{ width: "100%" }} size="small">
        {linesComputed.map((l) => (
          <Card key={l.key} size="small">
            <Space wrap size="middle" align="start">
              <Select
                placeholder="Модель двери"
                style={{ width: 260 }}
                showSearch
                optionFilterProp="label"
                loading={modelsQuery.isLoading}
                value={l.modelId}
                onChange={(v) => updateLine(l.key, { modelId: v })}
                options={(modelsQuery.data ?? [])
                  .filter((m) => m.is_active)
                  .map((m) => ({ value: m.id, label: m.name }))}
              />
              <InputNumber
                placeholder="Кол-во, шт"
                min={1}
                style={{ width: 120 }}
                value={l.qty}
                onChange={(v) => updateLine(l.key, { qty: v ?? 1 })}
              />
              <Select
                placeholder="Цвет плёнки"
                style={{ width: 300 }}
                showSearch
                optionFilterProp="label"
                loading={skusQuery.isLoading}
                value={l.skuId}
                onChange={(v) => updateLine(l.key, { skuId: v })}
                options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
              />
              <Statistic title="Расход по строке, м²" value={l.totalM2} />
              {!!l.model && (
                <Button type="link" onClick={() => updateLine(l.key, { showParts: !l.showParts })}>
                  {l.showParts ? "Скрыть по деталям" : "Показать по деталям"}
                </Button>
              )}
              {orderLines.length > 1 && (
                <Button icon={<DeleteOutlined />} danger type="text" onClick={() => removeLine(l.key)} />
              )}
            </Space>

            {l.showParts && l.model && (
              <ResponsiveTable<ProductModelPart & { area_m2: number }>
                tableKey="sales-film-estimate-parts"
                lockedColumns={["Деталь"]}
                rowKey="id"
                pagination={false}
                style={{ marginTop: 12 }}
                dataSource={l.model.parts.map((p) => ({ ...p, area_m2: partFilmAreaM2(p, l.qty) }))}
                scroll={{ x: "max-content" }}
                columns={[
                  { title: "Деталь", dataIndex: "part_name", render: (v: string | null) => v ?? "Без названия" },
                  { title: "Шт. на 1 изделие", dataIndex: "qty_per_unit" },
                  { title: "Шт. всего", render: (_, r) => r.qty_per_unit * l.qty },
                  { title: "Штрипс, мм", render: (_, r) => r.strip_width_mm ?? r.width_mm },
                  { title: "Длина, м", dataIndex: "length_m" },
                  { title: "Площадь, м²", render: (_, r) => r.area_m2.toFixed(2) },
                ]}
              />
            )}
          </Card>
        ))}
        <Button icon={<PlusOutlined />} onClick={addLine} block>
          Добавить дверь
        </Button>
      </Space>

      {summaryRows.length > 0 && (
        <Card title="Итог по цветам — остаток и резерв" loading={stockForSkusQuery.isLoading}>
          <ResponsiveTable<(typeof summaryRows)[number]>
            tableKey="sales-film-summary"
            lockedColumns={["Позиция"]}
            rowKey="skuId"
            pagination={false}
            dataSource={summaryRows}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Позиция", render: (_, r) => (r.sku ? skuLabel(r.sku) : "—") },
              { title: "Нужно на заказ, м²", render: (_, r) => r.needed.toFixed(2) },
              { title: "На складе, м²", render: (_, r) => (r.stock ? r.stock.total_area_m2.toFixed(2) : "—") },
              {
                title: "Резерв на текущие задания, м²",
                render: (_, r) => (r.stock ? r.stock.reserved_area_m2.toFixed(2) : "—"),
              },
              { title: "Доступно, м²", render: (_, r) => (r.stock ? r.stock.available_area_m2.toFixed(2) : "—") },
              {
                title: "Хватит?",
                render: (_, r) =>
                  r.shortage > 0 ? (
                    <Tag color="orange">Не хватает {r.shortage.toFixed(2)} м²</Tag>
                  ) : (
                    <Tag color="green">Хватает</Tag>
                  ),
              },
            ]}
          />
        </Card>
      )}

      <Typography.Title level={5} style={{ marginTop: 8, marginBottom: 0 }}>
        Остаток и аналоги по позиции
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        Выберите позицию, которую считаете клиенту — покажем остаток на складе и, если у позиции есть привязанные
        аналоги, подсветим те из них, что давно лежат без движения: их выгоднее предложить клиенту в первую очередь.
      </Typography.Paragraph>

      <Card size="small">
        <Space wrap size="middle">
          <Select
            placeholder="Материал, цвет, толщина, производитель"
            style={{ width: 420 }}
            showSearch
            optionFilterProp="label"
            loading={skusQuery.isLoading}
            value={skuId}
            onChange={setSkuId}
            options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
          />
          <InputNumber
            placeholder="Нужно клиенту, м²"
            min={0}
            style={{ width: 200 }}
            value={neededM2}
            onChange={(v) => setNeededM2(v ?? undefined)}
          />
        </Space>
      </Card>

      {sku && (
        <Card loading={analogsQuery.isLoading}>
          <Space align="start" size="large">
            <Photo sku={sku} size={96} />
            <Row gutter={32}>
              <Col>
                <Typography.Text strong>{skuLabel(sku)}</Typography.Text>
                <br />
                <Typography.Text type="secondary">
                  {sku.supplier_code ? `Код поставщика: ${sku.supplier_code}` : "Без кода поставщика"}
                </Typography.Text>
              </Col>
              <Col>
                <Statistic title="На складе, м²" value={stock} />
              </Col>
              {neededM2 !== undefined && (
                <Col>
                  <Statistic
                    title={shortageM2 && shortageM2 > 0 ? "Не хватает, м²" : "Хватает на заказ"}
                    value={shortageM2 && shortageM2 > 0 ? shortageM2 : "Да"}
                    valueStyle={{ color: shortageM2 && shortageM2 > 0 ? "#C97A2B" : "#2E7D32" }}
                  />
                </Col>
              )}
            </Row>
          </Space>
        </Card>
      )}

      {sku && (
        <Card title="Аналоги">
          {analogs.length === 0 ? (
            <Empty
              description="Аналоги не привязаны — можно добавить в «Администрирование → Справочники → Номенклатура»"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          ) : (
            <ResponsiveTable<AnalogEntry>
              tableKey="sales-analogs"
              lockedColumns={["Позиция"]}
              rowKey="link_id"
              pagination={false}
              dataSource={analogs}
              scroll={{ x: "max-content" }}
              rowClassName={(a) => (a.is_illiquid ? "sales-calc-illiquid-row" : "")}
              columns={[
                { title: "", width: 64, render: (_, a) => <Photo sku={a.sku} /> },
                { title: "Позиция", render: (_, a) => skuLabel(a.sku) },
                { title: "Остаток, м²", dataIndex: "stock_m2" },
                {
                  title: "Статус",
                  render: (_, a) =>
                    a.is_illiquid ? (
                      <Tag color="orange">Неликвид — {a.stale_days} дн. без движения</Tag>
                    ) : (
                      <Tag>В обороте</Tag>
                    ),
                },
                { title: "Комментарий", dataIndex: "note", render: (v: string | null) => v ?? "—" },
              ]}
            />
          )}
        </Card>
      )}
    </Space>
  );
}
