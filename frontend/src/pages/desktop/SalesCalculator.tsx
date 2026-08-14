import { useState } from "react";
import { Card, Select, InputNumber, Space, Typography, Tag, Image, Empty, Statistic, Row, Col } from "antd";
import ResponsiveTable from "../../components/ResponsiveTable";
import { PictureOutlined } from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { listMaterialSkus, getSkuAnalogs, skuPhotoUrl, type AnalogEntry } from "../../api/dictionaries";
import { skuLabel, type MaterialSku } from "../../api/units";

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
export default function SalesCalculator() {
  const [skuId, setSkuId] = useState<number | undefined>();
  const [neededM2, setNeededM2] = useState<number | undefined>();

  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus });
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
      <Typography.Paragraph type="secondary">
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
