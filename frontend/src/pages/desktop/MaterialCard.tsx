import { useEffect, useMemo, useState } from "react";
import { Card, Select, Row, Col, Statistic, Table, Space, Tag, Input, InputNumber, Button, Popconfirm, Modal, Typography, Empty, Upload, Image, message } from "antd";
import ResponsiveTable from "../../components/ResponsiveTable";
import { UploadOutlined, PictureOutlined } from "@ant-design/icons";
import type { UploadProps } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import {
  listMaterialSkus,
  listAllMaterialSkus,
  updateMaterialSku,
  getSkuAnalogs,
  addSkuAnalog,
  removeSkuAnalog,
  uploadSkuPhoto,
  deleteSkuPhoto,
  skuPhotoUrl,
  type MaterialSkuUpdate,
  type AnalogEntry,
} from "../../api/dictionaries";
import { getMaterialCard } from "../../api/materialCards";
import { skuLabel, type MaterialSku } from "../../api/units";
import { useAuth } from "../../auth/AuthContext";

interface MaterialCardPrefill {
  material?: string;
  color?: string;
  thickness?: number;
}

function SkuAnalogsModal({ sku, allSkus, onClose, canEdit }: { sku: MaterialSku; allSkus: MaterialSku[]; onClose: () => void; canEdit: boolean }) {
  const qc = useQueryClient();
  const [pickedAnalogId, setPickedAnalogId] = useState<number | undefined>();
  const [note, setNote] = useState("");

  const analogsQuery = useQuery({ queryKey: ["sku-analogs", sku.id], queryFn: () => getSkuAnalogs(sku.id) });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["sku-analogs", sku.id] });
    qc.invalidateQueries({ queryKey: ["material-skus"] });
  };

  const addMutation = useMutation({
    mutationFn: () => addSkuAnalog(sku.id, { analog_sku_id: pickedAnalogId!, note: note || undefined }),
    onSuccess: () => {
      invalidate();
      setPickedAnalogId(undefined);
      setNote("");
      message.success("Аналог добавлен");
    },
    onError: () => message.error("Не удалось добавить аналог"),
  });

  const removeMutation = useMutation({
    mutationFn: (linkId: number) => removeSkuAnalog(sku.id, linkId),
    onSuccess: () => {
      invalidate();
      message.success("Связь удалена");
    },
  });

  const photoMutation = useMutation({
    mutationFn: (file: File) => uploadSkuPhoto(sku.id, file),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      message.success("Фото загружено");
    },
    onError: () => message.error("Не удалось загрузить фото"),
  });

  const deletePhotoMutation = useMutation({
    mutationFn: () => deleteSkuPhoto(sku.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      message.success("Фото удалено");
    },
  });

  const linkedIds = new Set((analogsQuery.data?.analogs ?? []).map((a) => a.sku.id));
  const candidateSkus = allSkus.filter((s) => s.id !== sku.id && s.is_active && !linkedIds.has(s.id));
  const photoUrl = skuPhotoUrl(sku.photo_path);

  const uploadProps: UploadProps = {
    accept: "image/jpeg,image/png,image/webp",
    showUploadList: false,
    beforeUpload: (file) => {
      photoMutation.mutate(file);
      return false;
    },
  };

  return (
    <Modal title={`Аналоги и фото: ${skuLabel(sku)}`} open onCancel={onClose} footer={null} width={640} destroyOnHidden>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Card size="small" title="Фото плёнки">
          <Space align="start">
            {photoUrl ? (
              <Image src={photoUrl} width={120} height={120} style={{ objectFit: "cover" }} />
            ) : (
              <div
                style={{
                  width: 120,
                  height: 120,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "#f5f5f5",
                  color: "#999",
                }}
              >
                <PictureOutlined style={{ fontSize: 32 }} />
              </div>
            )}
            {canEdit && (
              <Space direction="vertical">
                <Upload {...uploadProps}>
                  <Button icon={<UploadOutlined />} loading={photoMutation.isPending}>
                    {photoUrl ? "Заменить фото" : "Загрузить фото"}
                  </Button>
                </Upload>
                {photoUrl && (
                  <Popconfirm title="Удалить фото?" onConfirm={() => deletePhotoMutation.mutate()}>
                    <Button danger size="small">
                      Удалить фото
                    </Button>
                  </Popconfirm>
                )}
              </Space>
            )}
          </Space>
        </Card>

        <Card size="small" title="Аналоги" loading={analogsQuery.isLoading}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            Ручная привязка — используется калькулятором продажника, чтобы предложить замену неликвидом (8 раздел
            обратной связи). Связь видна с обеих позиций.
          </Typography.Paragraph>
          {(analogsQuery.data?.analogs ?? []).length === 0 ? (
            <Empty description="Аналоги не привязаны" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          ) : (
            <ResponsiveTable<AnalogEntry>
              tableKey="material-card-analogs"
              lockedColumns={["Позиция"]}
              rowKey="link_id"
              size="small"
              pagination={false}
              dataSource={analogsQuery.data?.analogs}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "Позиция", render: (_, a) => skuLabel(a.sku) },
                { title: "Остаток, м²", dataIndex: "stock_m2" },
                {
                  title: "Неликвид",
                  render: (_, a) =>
                    a.is_illiquid ? <Tag color="orange">Давно не движется ({a.stale_days} дн.)</Tag> : <Tag>—</Tag>,
                },
                { title: "Комментарий", dataIndex: "note", render: (v: string | null) => v ?? "—" },
                ...(canEdit
                  ? [
                      {
                        title: "",
                        render: (_: unknown, a: AnalogEntry) => (
                          <Button size="small" danger onClick={() => removeMutation.mutate(a.link_id)}>
                            Удалить
                          </Button>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}

          {canEdit && (
            <Space style={{ marginTop: 12 }} wrap>
              <Select
                placeholder="Выбрать позицию"
                style={{ width: 320 }}
                value={pickedAnalogId}
                onChange={setPickedAnalogId}
                showSearch
                optionFilterProp="label"
                options={candidateSkus.map((s) => ({ value: s.id, label: skuLabel(s) }))}
              />
              <Input placeholder="Комментарий (необязательно)" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 200 }} />
              <Button type="primary" disabled={!pickedAnalogId} loading={addMutation.isPending} onClick={() => addMutation.mutate()}>
                + Добавить аналог
              </Button>
            </Space>
          )}
        </Card>
      </Space>
    </Modal>
  );
}

export default function MaterialCard() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = !!user?.is_superuser || !!user?.permissions.includes("materials.manage");

  const [skuId, setSkuId] = useState<number | null>(null);
  const [analogsOpen, setAnalogsOpen] = useState(false);
  const [editing, setEditing] = useState<MaterialSkuUpdate>({});
  // Архивные/без остатка позиции видны в выборе только тем, кто может их
  // редактировать (объединение "Остатков" и бывшей "Номенклатуры" по итогам
  // продуктового разбора — раньше архивные позиции были видны только на
  // отдельном администраторском экране).
  const skusQuery = useQuery({ queryKey: ["material-skus", canEdit ? "all" : "active"], queryFn: canEdit ? listAllMaterialSkus : listMaterialSkus });
  const qc = useQueryClient();

  useEffect(() => {
    const prefill = location.state as MaterialCardPrefill | null;
    if (!prefill || !skusQuery.data || skuId !== null) return;
    const match = skusQuery.data.find(
      (s) => s.material.name === prefill.material && s.color.name === prefill.color && s.thickness.value_mm === prefill.thickness,
    );
    if (match) setSkuId(match.id);
    // Приходим сюда по клику из агрегатной строки "Материалы" (2.2 раздел
    // бэклога доработок) — предвыбираем первую подходящую позицию по
    // материалу/цвету/толщине (без учёта производителя, как и сама агрегация).
  }, [location.state, skusQuery.data, skuId]);

  const selectedSku = (skusQuery.data ?? []).find((s) => s.id === skuId) ?? null;

  useEffect(() => {
    setEditing({});
  }, [skuId]);

  const updateMutation = useMutation({
    mutationFn: (payload: MaterialSkuUpdate) => updateMaterialSku(skuId!, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      setEditing({});
      message.success("Сохранено");
    },
    onError: () => message.error("Не удалось сохранить"),
  });

  const cardQuery = useQuery({
    queryKey: ["material-card", skuId],
    queryFn: () => getMaterialCard(skuId!),
    enabled: !!skuId,
  });

  const byWidth = useMemo(() => {
    if (!cardQuery.data) return [];
    const groups = new Map<number, { width_mm: number; length_m: number; locations: Set<string> }>();
    for (const u of cardQuery.data.units) {
      const g = groups.get(u.width_mm) ?? { width_mm: u.width_mm, length_m: 0, locations: new Set() };
      g.length_m += u.length_m;
      g.locations.add(u.location_code ?? u.area ?? "—");
      groups.set(u.width_mm, g);
    }
    return [...groups.values()].sort((a, b) => b.width_mm - a.width_mm);
  }, [cardQuery.data]);

  const statusCounts = useMemo(() => {
    if (!cardQuery.data) return {} as Record<string, number>;
    const counts: Record<string, number> = {};
    for (const u of cardQuery.data.units) counts[u.status] = (counts[u.status] ?? 0) + 1;
    return counts;
  }, [cardQuery.data]);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Карточка материала">
        <Select
          style={{ width: 420 }}
          placeholder="Выберите позицию материала"
          loading={skusQuery.isLoading}
          showSearch
          optionFilterProp="label"
          options={(skusQuery.data ?? []).map((s) => ({
            value: s.id,
            label: s.is_active ? skuLabel(s) : `${skuLabel(s)} (в архиве)`,
          }))}
          value={skuId ?? undefined}
          onChange={setSkuId}
        />

        {selectedSku && (
          <Space direction="vertical" size="small" style={{ marginTop: 16, width: "100%" }}>
            <Space wrap align="end">
              <div>
                <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                  Код у поставщика
                </Typography.Text>
                <Input
                  disabled={!canEdit}
                  size="small"
                  style={{ width: 160 }}
                  value={editing.supplier_code ?? selectedSku.supplier_code ?? ""}
                  onChange={(e) => setEditing((v) => ({ ...v, supplier_code: e.target.value }))}
                />
              </div>
              <div>
                <Typography.Text type="secondary" style={{ display: "block", fontSize: 12 }}>
                  Родная ширина, мм
                </Typography.Text>
                <InputNumber
                  disabled={!canEdit}
                  size="small"
                  min={1}
                  value={editing.native_width_mm ?? selectedSku.native_width_mm ?? undefined}
                  onChange={(v) => setEditing((s) => ({ ...s, native_width_mm: v ?? undefined }))}
                />
              </div>
              {canEdit && (
                <Button
                  size="small"
                  disabled={!Object.keys(editing).length}
                  loading={updateMutation.isPending}
                  onClick={() => updateMutation.mutate(editing)}
                >
                  Сохранить
                </Button>
              )}
              <Tag color={selectedSku.is_active ? "green" : "default"}>{selectedSku.is_active ? "Активна" : "В архиве"}</Tag>
              {canEdit && (
                <Button size="small" onClick={() => updateMutation.mutate({ is_active: !selectedSku.is_active })}>
                  {selectedSku.is_active ? "В архив" : "Восстановить"}
                </Button>
              )}
              <Button size="small" onClick={() => setAnalogsOpen(true)}>
                Аналоги/фото
              </Button>
            </Space>
          </Space>
        )}
      </Card>

      {cardQuery.data && (
        <>
          <Card>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={12} md={8}>
                <Statistic title="Общий остаток" value={cardQuery.data.total_area_m2} suffix="м²" />
              </Col>
              <Col xs={24} sm={12} md={8}>
                <Statistic title="Ширин в наличии" value={byWidth.length} />
              </Col>
            </Row>
          </Card>

          <Card title="Остатки по ширинам — где физически искать">
            <Table
              rowKey="width_mm"
              pagination={false}
              dataSource={byWidth}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "Ширина, мм", dataIndex: "width_mm" },
                { title: "Метры", dataIndex: "length_m" },
                { title: "Местоположение", render: (_, r) => [...r.locations].join(", ") },
              ]}
            />
          </Card>

          <Card title="Разбивка по статусам">
            <Space>
              {Object.entries(statusCounts).map(([status, count]) => (
                <Tag key={status}>
                  {status}: {count}
                </Tag>
              ))}
            </Space>
          </Card>

          <Card title="Список физических единиц">
            <Table
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10 }}
              dataSource={cardQuery.data.units}
              scroll={{ x: "max-content" }}
              onRow={(u) => ({
                onClick: () => navigate("/m/unit-card", { state: { unitId: u.id } }),
                style: { cursor: "pointer" },
              })}
              columns={[
                { title: "ID", dataIndex: "id" },
                { title: "Ширина×длина", render: (_, u) => `${u.width_mm}×${u.length_m}` },
                { title: "Статус", dataIndex: "status" },
                { title: "Адрес/участок", render: (_, u) => u.location_code ?? u.area ?? "—" },
              ]}
            />
          </Card>

          <Card title="Журнал движений">
            <ResponsiveTable
              tableKey="material-card-events"
              lockedColumns={["Когда", "Событие"]}
              rowKey="event_id"
              size="small"
              pagination={{ pageSize: 10 }}
              dataSource={cardQuery.data.events}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "Когда", dataIndex: "timestamp", render: (v) => new Date(v).toLocaleString("ru-RU") },
                { title: "Событие", dataIndex: "event_type" },
                { title: "Ед.", dataIndex: "unit_id" },
                { title: "Δ метры", dataIndex: "quantity_delta_m" },
              ]}
            />
          </Card>
        </>
      )}

      {analogsOpen && selectedSku && (
        <SkuAnalogsModal sku={selectedSku} allSkus={skusQuery.data ?? []} onClose={() => setAnalogsOpen(false)} canEdit={canEdit} />
      )}
    </Space>
  );
}
