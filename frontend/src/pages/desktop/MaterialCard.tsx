import { useEffect, useMemo, useState } from "react";
import { Card, Select, Row, Col, Table, Space, Tag, Input, InputNumber, Button, Popconfirm, Modal, Form, Typography, Empty, Upload, Image, Checkbox, Radio, List, message } from "antd";
import Statistic from "../../components/Statistic";
import ResponsiveTable from "../../components/ResponsiveTable";
import { UploadOutlined, PictureOutlined } from "@ant-design/icons";
import type { UploadProps } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import {
  listMaterialSkus,
  listAllMaterialSkus,
  updateMaterialSku,
  deleteMaterialSku,
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
import { reassignUnitSku, receiveAndAutoPlace, printLabel, skuLabel, type MaterialSku, type MaterialUnit } from "../../api/units";
import DictAutoComplete from "../../components/DictAutoComplete";
import OccurredAtField from "../../components/OccurredAtField";
import { useAuth } from "../../auth/AuthContext";
import { toOccurredAtIso } from "../../utils/occurredAt";
import type { Dayjs } from "dayjs";

interface MaterialCardPrefill {
  material?: string;
  color?: string;
  thickness?: number;
}

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
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
  const [showArchived, setShowArchived] = useState(false);
  const [analogsOpen, setAnalogsOpen] = useState(false);
  const [addUnitOpen, setAddUnitOpen] = useState(false);
  const [reassignTarget, setReassignTarget] = useState<MaterialUnit | null>(null);
  const [editing, setEditing] = useState<MaterialSkuUpdate>({});
  // Раздел про поиск нужного размера на карточке материала — раньше
  // список единиц можно было только пролистать целиком, без фильтра.
  const [minWidthFilter, setMinWidthFilter] = useState<number | undefined>();
  const [minLengthFilter, setMinLengthFilter] = useState<number | undefined>();
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

  const deleteMutation = useMutation({
    mutationFn: () => deleteMaterialSku(skuId!),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      if (result.deleted) setSkuId(null);
      message.success(result.requested ? "Заявка на удаление отправлена администратору" : "Позиция удалена");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить — есть история (единицы, аналоги, журнал движений)?")),
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

  const filteredUnits = useMemo(() => {
    const units = cardQuery.data?.units ?? [];
    return units.filter(
      (u) => (minWidthFilter == null || u.width_mm >= minWidthFilter) && (minLengthFilter == null || u.length_m >= minLengthFilter),
    );
  }, [cardQuery.data, minWidthFilter, minLengthFilter]);

  const statusCounts = useMemo(() => {
    if (!cardQuery.data) return {} as Record<string, number>;
    const counts: Record<string, number> = {};
    for (const u of cardQuery.data.units) counts[u.status] = (counts[u.status] ?? 0) + 1;
    return counts;
  }, [cardQuery.data]);

  // Раздел про недостающий разбор рулон/штрипс — is_strip уже есть на
  // каждой единице, тот же приём агрегации, что statusCounts выше.
  const rollStripCounts = useMemo(() => {
    const result = { rolls: 0, rollsLengthM: 0, strips: 0, stripsLengthM: 0 };
    if (!cardQuery.data) return result;
    for (const u of cardQuery.data.units) {
      if (u.is_strip) {
        result.strips += 1;
        result.stripsLengthM += u.length_m;
      } else {
        result.rolls += 1;
        result.rollsLengthM += u.length_m;
      }
    }
    return result;
  }, [cardQuery.data]);

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card title="Карточка материала">
        {canEdit && (
          <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ marginBottom: 8 }}>
            Показывать архивные
          </Checkbox>
        )}
        <br />
        <Select
          style={{ width: 420 }}
          placeholder="Выберите позицию материала"
          loading={skusQuery.isLoading}
          showSearch
          optionFilterProp="label"
          options={(skusQuery.data ?? [])
            .filter((s) => showArchived || s.is_active)
            .map((s) => ({
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
              {canEdit && (
                <Button size="small" danger loading={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
                  {user?.is_superuser ? "Удалить" : "Запросить удаление"}
                </Button>
              )}
              <Button size="small" onClick={() => setAnalogsOpen(true)}>
                Аналоги/фото
              </Button>
              {canEdit && (
                <Button size="small" type="primary" onClick={() => setAddUnitOpen(true)}>
                  + Добавить единицу
                </Button>
              )}
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
              <Col xs={24} sm={12} md={4}>
                <Statistic title="Рулонов" value={rollStripCounts.rolls} suffix={`шт · ${rollStripCounts.rollsLengthM} м`} />
              </Col>
              <Col xs={24} sm={12} md={4}>
                <Statistic title="Штрипсов" value={rollStripCounts.strips} suffix={`шт · ${rollStripCounts.stripsLengthM} м`} />
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
            <Space style={{ marginBottom: 12 }} wrap>
              <InputNumber
                placeholder="Ширина от, мм"
                min={0}
                value={minWidthFilter}
                onChange={(v) => setMinWidthFilter(v ?? undefined)}
              />
              <InputNumber
                placeholder="Длина от, м"
                min={0}
                step={0.1}
                value={minLengthFilter}
                onChange={(v) => setMinLengthFilter(v ?? undefined)}
              />
            </Space>
            <ResponsiveTable<MaterialUnit>
              tableKey="material-card-units"
              rowKey="id"
              size="small"
              pagination={{ pageSize: 10 }}
              dataSource={filteredUnits}
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
                ...(canEdit
                  ? [
                      {
                        title: "",
                        render: (_: unknown, u: MaterialUnit) => (
                          <Button
                            size="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              setReassignTarget(u);
                            }}
                          >
                            Изменить
                          </Button>
                        ),
                      },
                    ]
                  : []),
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

      {reassignTarget && <ReassignSkuModal unit={reassignTarget} onClose={() => setReassignTarget(null)} />}
      {addUnitOpen && selectedSku && <AddUnitModal sku={selectedSku} onClose={() => setAddUnitOpen(false)} />}
    </Space>
  );
}

/** Добавить ещё одну физическую единицу этого материала прямо с карточки
 * (раздел про недостающую возможность) — материал/цвет/толщина/
 * производитель уже зафиксированы выбранной позицией, спрашиваем только
 * тип/размер. Тот же приём, что "Единица плёнки вне сессии приёмки" в
 * MaterialsExplorer.tsx — receiveAndAutoPlace, без нового бэкенд-эндпоинта. */
function AddUnitModal({ sku, onClose }: { sku: MaterialSku; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{
    is_strip: boolean;
    width_mm: number;
    length_m: number;
    upd_number?: string;
    pallet_number?: string;
    occurred_at?: Dayjs | null;
  }>();
  const [createdUnits, setCreatedUnits] = useState<MaterialUnit[]>([]);

  const addMutation = useMutation({
    mutationFn: (v: {
      is_strip: boolean;
      width_mm: number;
      length_m: number;
      upd_number?: string;
      pallet_number?: string;
      occurred_at?: Dayjs | null;
    }) =>
      receiveAndAutoPlace({
        material: sku.material.name,
        color: sku.color.name,
        thickness: sku.thickness.value_mm,
        manufacturer: sku.manufacturer.name,
        is_strip: v.is_strip,
        width_mm: v.width_mm,
        length_m: v.length_m,
        upd_number: v.upd_number?.trim() || "Без документа",
        pallet_number: v.pallet_number?.trim() || "-",
        quantity: 1,
        occurred_at: toOccurredAtIso(v.occurred_at),
      }),
    onSuccess: (units) => {
      qc.invalidateQueries({ queryKey: ["material-card", sku.id] });
      setCreatedUnits(units);
      form.resetFields();
      message.success(`Единица №${units[0].id} зарегистрирована`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось зарегистрировать единицу")),
  });

  return (
    <Modal title={`Добавить единицу — ${skuLabel(sku)}`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={{ is_strip: false }} onFinish={(v) => addMutation.mutate(v)}>
        <Form.Item name="is_strip" label="Тип">
          <Radio.Group
            options={[
              { label: "Рулон", value: false },
              { label: "Штрипс", value: true },
            ]}
            optionType="button"
          />
        </Form.Item>
        <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]}>
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
          <InputNumber min={0.1} step={0.1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="upd_number" label="Номер УПД (необязательно)">
          <Input placeholder="Без документа" />
        </Form.Item>
        <Form.Item name="pallet_number" label="Номер паллеты (необязательно)">
          <Input />
        </Form.Item>
        <OccurredAtField label="Дата приёмки (необязательно — по умолчанию сейчас)" />
        <Button type="primary" htmlType="submit" block loading={addMutation.isPending}>
          Зарегистрировать
        </Button>
      </Form>

      {createdUnits.length > 0 && (
        <List
          style={{ marginTop: 16 }}
          size="small"
          bordered
          dataSource={createdUnits}
          renderItem={(u) => (
            <List.Item actions={[<Button key="print" size="small" onClick={() => printLabel(u.id)}>Печать бирки</Button>]}>
              № {u.id} — {u.width_mm}×{u.length_m}, {u.location_code ?? "без места"}
            </List.Item>
          )}
        />
      )}
    </Modal>
  );
}

/** Исправление ошибки ввода (раздел про карточку материала) — единица
 * попала не в ту номенклатуру (например, при внесении начальных
 * остатков перепутали материал/цвет), а пересоздавать её вручную —
 * терять id и историю движений. Меняет только material_sku_id, единица
 * физически никуда не переезжает. */
function ReassignSkuModal({ unit, onClose }: { unit: MaterialUnit; onClose: () => void }) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{ material: string; color: string; thickness: number; manufacturer: string }>();

  const reassignMutation = useMutation({
    mutationFn: (v: { material: string; color: string; thickness: number; manufacturer: string }) =>
      reassignUnitSku(unit.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["material-card"] });
      qc.invalidateQueries({ queryKey: ["materials-explorer"] });
      message.success(`Номенклатура единицы №${unit.id} изменена`);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось изменить номенклатуру")),
  });

  return (
    <Modal title={`Изменить номенклатуру — единица №${unit.id}`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Исправление ошибки ввода — единица остаётся той же (id, история движений, адрес не меняются), меняется только
        привязка к материалу/цвету/толщине/производителю.
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          material: unit.material_sku.material.name,
          color: unit.material_sku.color.name,
          thickness: unit.material_sku.thickness.value_mm,
          manufacturer: unit.material_sku.manufacturer.name,
        }}
        onFinish={(v) => reassignMutation.mutate(v)}
      >
        <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
          <DictAutoComplete kind="materials" />
        </Form.Item>
        <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
          <DictAutoComplete kind="colors" />
        </Form.Item>
        <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
          <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
          <DictAutoComplete kind="manufacturers" />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={reassignMutation.isPending}>
          Сохранить
        </Button>
      </Form>
    </Modal>
  );
}
