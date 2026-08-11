import { useState } from "react";
import {
  Card,
  Tabs,
  Table,
  Button,
  Input,
  InputNumber,
  Select,
  Tag,
  Space,
  Popconfirm,
  Typography,
  Empty,
  Modal,
  Upload,
  Image,
  message,
} from "antd";
import { UploadOutlined, PictureOutlined } from "@ant-design/icons";
import type { UploadProps } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listAllNameDict,
  listNameDictDuplicates,
  updateNameDictEntry,
  listAllThicknesses,
  updateThicknessEntry,
  listAllMaterialSkus,
  updateMaterialSku,
  getSkuAnalogs,
  addSkuAnalog,
  removeSkuAnalog,
  uploadSkuPhoto,
  deleteSkuPhoto,
  skuPhotoUrl,
  type NameDictKind,
  type DictEntry,
  type DuplicateCandidate,
  type ThicknessEntry,
  type MaterialSkuUpdate,
  type AnalogEntry,
} from "../../api/dictionaries";
import type { MaterialSku } from "../../api/units";
import { skuLabel } from "../../api/units";

function SkuAnalogsModal({ sku, allSkus, onClose }: { sku: MaterialSku; allSkus: MaterialSku[]; onClose: () => void }) {
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
            <Table<AnalogEntry>
              rowKey="link_id"
              size="small"
              pagination={false}
              dataSource={analogsQuery.data?.analogs}
              columns={[
                { title: "Позиция", render: (_, a) => skuLabel(a.sku) },
                { title: "Остаток, м²", dataIndex: "stock_m2" },
                {
                  title: "Неликвид",
                  render: (_, a) =>
                    a.is_illiquid ? <Tag color="orange">Давно не движется ({a.stale_days} дн.)</Tag> : <Tag>—</Tag>,
                },
                { title: "Комментарий", dataIndex: "note", render: (v: string | null) => v ?? "—" },
                {
                  title: "",
                  render: (_, a) => (
                    <Button size="small" danger onClick={() => removeMutation.mutate(a.link_id)}>
                      Удалить
                    </Button>
                  ),
                },
              ]}
            />
          )}

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
        </Card>
      </Space>
    </Modal>
  );
}

function NomenclatureTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Record<number, MaterialSkuUpdate>>({});
  const [analogsForId, setAnalogsForId] = useState<number | null>(null);
  const skusQuery = useQuery({ queryKey: ["material-skus", "all"], queryFn: listAllMaterialSkus });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: MaterialSkuUpdate }) => updateMaterialSku(id, payload),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      setEditing((s) => {
        const next = { ...s };
        delete next[vars.id];
        return next;
      });
      message.success("Сохранено");
    },
    onError: () => message.error("Не удалось сохранить"),
  });

  const setField = (id: number, patch: MaterialSkuUpdate) =>
    setEditing((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary">
        Это и есть номенклатура — каждая строка комбинация материал+цвет+толщина+производитель (справочники ниже
        по вкладкам — только их отдельные составляющие). Код у поставщика и родная ширина рулона можно править
        прямо здесь; сама комбинация атрибутов неизменна — заводится заново через приёмку или кнопку «+ Новое» на
        «Остатках», если нужна другая.
      </Typography.Paragraph>
      <Table<MaterialSku>
        rowKey="id"
        loading={skusQuery.isLoading}
        dataSource={skusQuery.data ?? []}
        pagination={{ pageSize: 20 }}
        columns={[
          {
            title: "",
            width: 48,
            render: (_, s) =>
              skuPhotoUrl(s.photo_path) ? (
                <Image src={skuPhotoUrl(s.photo_path)!} width={36} height={36} style={{ objectFit: "cover" }} preview={{ mask: false }} />
              ) : (
                <PictureOutlined style={{ color: "#ccc", fontSize: 18 }} />
              ),
          },
          { title: "Материал", render: (_, s) => s.material.name },
          { title: "Цвет", render: (_, s) => s.color.name },
          { title: "Толщина, мм", render: (_, s) => s.thickness.value_mm },
          { title: "Производитель", render: (_, s) => s.manufacturer.name },
          {
            title: "Код у поставщика",
            render: (_, s) => (
              <Input
                size="small"
                value={editing[s.id]?.supplier_code ?? s.supplier_code ?? ""}
                onChange={(e) => setField(s.id, { supplier_code: e.target.value })}
                style={{ maxWidth: 160 }}
              />
            ),
          },
          {
            title: "Родная ширина, мм",
            render: (_, s) => (
              <InputNumber
                size="small"
                min={1}
                value={editing[s.id]?.native_width_mm ?? s.native_width_mm ?? undefined}
                onChange={(v) => setField(s.id, { native_width_mm: v ?? undefined })}
              />
            ),
          },
          {
            title: "Статус",
            dataIndex: "is_active",
            render: (v: boolean) => (v ? <Tag color="green">Активна</Tag> : <Tag>В архиве</Tag>),
          },
          {
            title: "",
            render: (_, s) => (
              <Space>
                <Button
                  size="small"
                  disabled={!editing[s.id]}
                  onClick={() => updateMutation.mutate({ id: s.id, payload: editing[s.id] })}
                >
                  Сохранить
                </Button>
                <Button
                  size="small"
                  onClick={() => updateMutation.mutate({ id: s.id, payload: { is_active: !s.is_active } })}
                >
                  {s.is_active ? "В архив" : "Восстановить"}
                </Button>
                <Button size="small" onClick={() => setAnalogsForId(s.id)}>
                  Аналоги/фото
                </Button>
              </Space>
            ),
          },
        ]}
      />
      {analogsForId && (() => {
        const sku = (skusQuery.data ?? []).find((s) => s.id === analogsForId);
        return sku ? (
          <SkuAnalogsModal sku={sku} allSkus={skusQuery.data ?? []} onClose={() => setAnalogsForId(null)} />
        ) : null;
      })()}
    </Space>
  );
}

function NameDictTab({ kind, label }: { kind: NameDictKind; label: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Record<number, string>>({});

  const entriesQuery = useQuery({ queryKey: [kind, "all"], queryFn: () => listAllNameDict(kind) });
  const duplicatesQuery = useQuery({ queryKey: [kind, "duplicates"], queryFn: () => listNameDictDuplicates(kind) });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: { name?: string; is_active?: boolean } }) =>
      updateNameDictEntry(kind, id, payload),
    onSuccess: () => {
      // [kind] (без "all") — отдельный ключ кэша автокомплита (DictAutoComplete),
      // ["material-skus"] — везде, где название подтягивается через позицию
      // материала (Остатки, карточка материала, выдача, инвентаризация,
      // калькулятор продажника). Без этих двух инвалидаций переименование
      // применялось только на этой вкладке — старое название висело в кэше
      // остальных экранов до перезагрузки страницы целиком.
      qc.invalidateQueries({ queryKey: [kind] });
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      message.success("Сохранено");
    },
    onError: () => message.error("Не удалось сохранить — проверьте, что значение не занято"),
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Table<DictEntry>
        rowKey="id"
        loading={entriesQuery.isLoading}
        dataSource={entriesQuery.data ?? []}
        pagination={false}
        columns={[
          {
            title: label,
            dataIndex: "name",
            render: (_, entry) => (
              <Input
                value={editing[entry.id] ?? entry.name}
                onChange={(e) => setEditing((s) => ({ ...s, [entry.id]: e.target.value }))}
                onPressEnter={() => updateMutation.mutate({ id: entry.id, payload: { name: editing[entry.id] } })}
                style={{ maxWidth: 320 }}
              />
            ),
          },
          {
            title: "Статус",
            dataIndex: "is_active",
            width: 140,
            render: (active: boolean) => (active ? <Tag color="green">Активно</Tag> : <Tag>В архиве</Tag>),
          },
          {
            title: "",
            width: 220,
            render: (_, entry) => (
              <Space>
                <Button
                  size="small"
                  disabled={!editing[entry.id] || editing[entry.id] === entry.name}
                  onClick={() => updateMutation.mutate({ id: entry.id, payload: { name: editing[entry.id] } })}
                >
                  Переименовать
                </Button>
                <Button
                  size="small"
                  onClick={() => updateMutation.mutate({ id: entry.id, payload: { is_active: !entry.is_active } })}
                >
                  {entry.is_active ? "В архив" : "Восстановить"}
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Card size="small" title="Возможные дубликаты" loading={duplicatesQuery.isLoading}>
        {(duplicatesQuery.data ?? []).length === 0 ? (
          <Empty description="Похожих значений не найдено" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Table<DuplicateCandidate>
            rowKey={(d) => `${d.a_id}-${d.b_id}`}
            size="small"
            pagination={false}
            dataSource={duplicatesQuery.data}
            columns={[
              { title: "Значение A", dataIndex: "a_name" },
              { title: "Значение B", dataIndex: "b_name" },
              { title: "Похожесть", dataIndex: "score", render: (v: number) => `${Math.round(v * 100)}%` },
              {
                title: "",
                render: (_, d) => (
                  <Popconfirm
                    title={`Архивировать «${d.b_name}»?`}
                    description="Значение останется в системе для старых записей, но пропадёт из подсказок."
                    onConfirm={() => updateMutation.mutate({ id: d.b_id, payload: { is_active: false } })}
                  >
                    <Button size="small" danger>
                      Архивировать B
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />
        )}
      </Card>
    </Space>
  );
}

function ThicknessTab() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Record<number, number>>({});
  const entriesQuery = useQuery({ queryKey: ["thicknesses", "all"], queryFn: listAllThicknesses });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: { value_mm?: number; is_active?: boolean } }) =>
      updateThicknessEntry(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["thicknesses"] });
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      message.success("Сохранено");
    },
    onError: () => message.error("Не удалось сохранить — такая толщина уже есть"),
  });

  return (
    <Table<ThicknessEntry>
      rowKey="id"
      loading={entriesQuery.isLoading}
      dataSource={entriesQuery.data ?? []}
      pagination={false}
      columns={[
        {
          title: "Толщина, мм",
          dataIndex: "value_mm",
          render: (_, entry) => (
            <InputNumber
              value={editing[entry.id] ?? entry.value_mm}
              min={0}
              step={0.01}
              onChange={(v) => setEditing((s) => ({ ...s, [entry.id]: v ?? entry.value_mm }))}
            />
          ),
        },
        {
          title: "Статус",
          dataIndex: "is_active",
          width: 140,
          render: (active: boolean) => (active ? <Tag color="green">Активно</Tag> : <Tag>В архиве</Tag>),
        },
        {
          title: "",
          width: 220,
          render: (_, entry) => (
            <Space>
              <Button
                size="small"
                disabled={editing[entry.id] === undefined || editing[entry.id] === entry.value_mm}
                onClick={() => updateMutation.mutate({ id: entry.id, payload: { value_mm: editing[entry.id] } })}
              >
                Сохранить
              </Button>
              <Button
                size="small"
                onClick={() => updateMutation.mutate({ id: entry.id, payload: { is_active: !entry.is_active } })}
              >
                {entry.is_active ? "В архив" : "Восстановить"}
              </Button>
            </Space>
          ),
        },
      ]}
    />
  );
}

export default function DictionaryAdmin() {
  return (
    <Card>
      <Typography.Title level={4}>Номенклатура и справочники</Typography.Title>
      <Typography.Paragraph type="secondary">
        Архивные значения пропадают из подсказок при вводе, но не удаляются — старые записи, где они уже
        использованы, остаются читаемыми.
      </Typography.Paragraph>
      <Tabs
        items={[
          { key: "nomenclature", label: "Номенклатура", children: <NomenclatureTab /> },
          { key: "materials", label: "Материалы (тип)", children: <NameDictTab kind="materials" label="Материал" /> },
          { key: "colors", label: "Цвета", children: <NameDictTab kind="colors" label="Цвет" /> },
          { key: "manufacturers", label: "Производители", children: <NameDictTab kind="manufacturers" label="Производитель" /> },
          { key: "thicknesses", label: "Толщины", children: <ThicknessTab /> },
        ]}
      />
    </Card>
  );
}
