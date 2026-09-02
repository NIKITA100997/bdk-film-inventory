import { useState } from "react";
import { Card, Select, InputNumber, Space, Typography, Tag, Image, Empty, Row, Col } from "antd";
import Statistic from "../../components/Statistic";
import ResponsiveTable from "../../components/ResponsiveTable";
import { PictureOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { listMaterialSkus, getSkuAnalogs, skuPhotoUrl, type AnalogEntry } from "../../api/dictionaries";
import { skuLabel, type MaterialSku } from "../../api/units";
import { listProductModels, type ProductModelPart } from "../../api/production";

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

export default function SalesCalculator() {
  const [skuId, setSkuId] = useState<number | undefined>();
  const [neededM2, setNeededM2] = useState<number | undefined>();
  const [modelId, setModelId] = useState<number | undefined>();
  const [orderQty, setOrderQty] = useState<number>(1);

  const modelsQuery = useQuery({ queryKey: ["product-models"], queryFn: listProductModels });
  const model = (modelsQuery.data ?? []).find((m) => m.id === modelId);
  const filmRows = (model?.parts ?? []).map((p) => ({ ...p, area_m2: partFilmAreaM2(p, orderQty) }));
  const filmTotalM2 = Math.round(filmRows.reduce((sum, r) => sum + r.area_m2, 0) * 100) / 100;

  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });
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
        Выберите модель двери (с нужным размером) и количество — покажем, сколько плёнки понадобится по деталям
        (штрипс на деталь × длина × количество на изделие × количество изделий), с итогом по всем деталям.
        Цвет/материал плёнки здесь не выбирается — это делается позже, при создании производственного задания.
      </Typography.Paragraph>

      <Card size="small">
        <Space wrap size="middle">
          <Select
            placeholder="Модель двери"
            style={{ width: 320 }}
            showSearch
            optionFilterProp="label"
            loading={modelsQuery.isLoading}
            value={modelId}
            onChange={setModelId}
            options={(modelsQuery.data ?? [])
              .filter((m) => m.is_active)
              .map((m) => ({ value: m.id, label: m.name }))}
          />
          <InputNumber
            placeholder="Количество, шт"
            min={1}
            style={{ width: 160 }}
            value={orderQty}
            onChange={(v) => setOrderQty(v ?? 1)}
          />
        </Space>
      </Card>

      {model && (
        <Card
          title={`${model.name} × ${orderQty} шт`}
          extra={<Statistic title="Итого расход плёнки, м²" value={filmTotalM2} valueStyle={{ color: "#C97A2B" }} />}
        >
          <ResponsiveTable<(typeof filmRows)[number]>
            tableKey="sales-film-estimate"
            lockedColumns={["Деталь"]}
            rowKey="id"
            pagination={false}
            dataSource={filmRows}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Деталь", dataIndex: "part_name", render: (v: string | null) => v ?? "Без названия" },
              { title: "Шт. на 1 изделие", dataIndex: "qty_per_unit" },
              { title: "Шт. всего", render: (_, r) => r.qty_per_unit * orderQty },
              { title: "Штрипс, мм", render: (_, r) => r.strip_width_mm ?? r.width_mm },
              { title: "Длина, м", dataIndex: "length_m" },
              { title: "Площадь, м²", render: (_, r) => r.area_m2.toFixed(2) },
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
