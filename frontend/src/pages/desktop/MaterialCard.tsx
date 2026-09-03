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
  mergeMaterialSku,
  type MaterialSkuUpdate,
  type AnalogEntry,
} from "../../api/dictionaries";
import { getMaterialCardByGroup } from "../../api/materialCards";
import { listWarehouses } from "../../api/storage";
import { reassignUnitSku, receiveAndAutoPlace, printLabel, skuLabel, type MaterialSku, type MaterialUnit } from "../../api/units";
import DictAutoComplete from "../../components/DictAutoComplete";
import OccurredAtField from "../../components/OccurredAtField";
import { useAuth } from "../../auth/AuthContext";
import { toOccurredAtIso } from "../../utils/occurredAt";
import { useWarehouseFilter } from "../../hooks/useWarehouseFilter";
import type { Dayjs } from "dayjs";

interface MaterialCardPrefill {
  material?: string;
  color?: string;
  thickness?: number;
  manufacturer?: string;
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

/** Объединение двух позиций номенклатуры, оказавшихся одним и тем же
 * материалом под разными названиями (реальные случаи этой сессии — "Орех"/
 * "Грецкий Орех", "Бьянко"/"Бьянко TF53") — раньше делалось точечными
 * SQL-скриптами вручную. survivor выбирает, какая из двух остаётся
 * действующей — остатки/история другой переносятся на неё, сама она
 * уходит в архив (не удаляется). */
function MergeSkuModal({ sku, allSkus, onClose }: { sku: MaterialSku; allSkus: MaterialSku[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [otherSkuId, setOtherSkuId] = useState<number | undefined>();
  const [survivor, setSurvivor] = useState<"current" | "other">("current");

  const candidateSkus = allSkus.filter((s) => s.id !== sku.id);
  const other = candidateSkus.find((s) => s.id === otherSkuId);

  const mergeMutation = useMutation({
    mutationFn: () => {
      const loserId = survivor === "current" ? other!.id : sku.id;
      const survivorId = survivor === "current" ? sku.id : other!.id;
      return mergeMaterialSku(loserId, survivorId);
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      message.success(`Объединено — перенесено единиц: ${result.moved_units}, событий журнала: ${result.moved_events}`);
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось объединить")),
  });

  return (
    <Modal title={`Объединить позицию: ${skuLabel(sku)}`} open onCancel={onClose} footer={null} width={520} destroyOnHidden>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Paragraph type="secondary">
          Для двух позиций, оказавшихся одним и тем же материалом под разными названиями (дубль/опечатка в
          справочнике) — весь остаток, история движений и связи объединяемой позиции переносятся на оставшуюся,
          сама она уходит в архив. Отменить это действие нельзя.
        </Typography.Paragraph>
        <Select
          placeholder="С какой позицией объединить"
          style={{ width: "100%" }}
          value={otherSkuId}
          onChange={setOtherSkuId}
          showSearch
          optionFilterProp="label"
          options={candidateSkus.map((s) => ({ value: s.id, label: skuLabel(s) }))}
        />
        {other && (
          <>
            <Radio.Group value={survivor} onChange={(e) => setSurvivor(e.target.value)}>
              <Space direction="vertical">
                <Radio value="current">Останется: {skuLabel(sku)} (эта карточка)</Radio>
                <Radio value="other">Останется: {skuLabel(other)}</Radio>
              </Space>
            </Radio.Group>
            <Popconfirm
              title="Объединить позиции?"
              description="Остатки и история объединяемой позиции переносятся на оставшуюся, отменить нельзя."
              onConfirm={() => mergeMutation.mutate()}
              okText="Да, объединить"
              cancelText="Отмена"
            >
              <Button type="primary" danger loading={mergeMutation.isPending}>
                Объединить
              </Button>
            </Popconfirm>
          </>
        )}
      </Space>
    </Modal>
  );
}

export default function MaterialCard() {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const canEdit = !!user?.is_superuser || !!user?.permissions.includes("materials.manage");
  // Раздел про кнопку "+ Добавить единицу" — сама операция бьёт в тот же
  // /units/receive, что и обычная "Приёмка плёнки" (units.receive), а не
  // в справочники (materials.manage) — раньше кнопка была спрятана за
  // materials.manage, из-за чего кладовщик с units.receive (у него и так
  // есть доступ к "Приёмке") не видел её на карточке материала вообще.
  const canAddUnit = !!user?.is_superuser || !!user?.permissions.includes("units.receive");

  const [groupKey, setGroupKey] = useState<{ material: string; color: string; thickness: number } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [analogsTarget, setAnalogsTarget] = useState<MaterialSku | null>(null);
  const [mergeTarget, setMergeTarget] = useState<MaterialSku | null>(null);
  const [addUnitOpen, setAddUnitOpen] = useState(false);
  const [reassignTarget, setReassignTarget] = useState<MaterialUnit | null>(null);
  // Раздел про производителя внутри карточки материала (не отдельным
  // измерением) — черновик правки теперь на строку таблицы производителей
  // (sku.id), не один на всю карточку, как раньше.
  const [editingBySku, setEditingBySku] = useState<Record<number, MaterialSkuUpdate>>({});
  // Раздел про поиск нужного размера на карточке материала — раньше
  // список единиц можно было только пролистать целиком, без фильтра.
  const [minWidthFilter, setMinWidthFilter] = useState<number | undefined>();
  const [minLengthFilter, setMinLengthFilter] = useState<number | undefined>();
  // Архивные/без остатка позиции видны в выборе только тем, кто может их
  // редактировать (объединение "Остатков" и бывшей "Номенклатуры" по итогам
  // продуктового разбора — раньше архивные позиции были видны только на
  // отдельном администраторском экране).
  const skusQuery = useQuery({
    queryKey: ["material-skus", canEdit ? "all" : "active"],
    queryFn: () => (canEdit ? listAllMaterialSkus() : listMaterialSkus()),
  });
  const qc = useQueryClient();

  useEffect(() => {
    const prefill = location.state as MaterialCardPrefill | null;
    if (!prefill?.material || !prefill.color || prefill.thickness === undefined || groupKey !== null) return;
    // Приходим сюда по клику из агрегатной строки "Материалы"/"Стеллажи"/
    // карточки единицы — материал/цвет/толщина уже однозначно задают
    // группу, ждать загрузки skusQuery не нужно (производитель в prefill,
    // если он есть от старых вызывающих, больше не участвует в выборе —
    // карточка теперь на всю группу сразу, не на одного производителя).
    setGroupKey({ material: prefill.material, color: prefill.color, thickness: prefill.thickness });
  }, [location.state, groupKey]);

  const skusInGroup = useMemo(() => {
    if (!groupKey) return [];
    return (skusQuery.data ?? []).filter(
      (s) =>
        s.material.name === groupKey.material &&
        s.color.name === groupKey.color &&
        s.thickness.value_mm === groupKey.thickness &&
        (showArchived || s.is_active),
    );
  }, [skusQuery.data, groupKey, showArchived]);

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: MaterialSkuUpdate }) => updateMaterialSku(id, payload),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      qc.invalidateQueries({ queryKey: ["material-card-group"] });
      setEditingBySku((v) => {
        const next = { ...v };
        delete next[id];
        return next;
      });
      message.success("Сохранено");
    },
    onError: () => message.error("Не удалось сохранить"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteMaterialSku(id),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      qc.invalidateQueries({ queryKey: ["material-card-group"] });
      message.success(result.requested ? "Заявка на удаление отправлена администратору" : "Позиция удалена");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить — есть история (единицы, аналоги, журнал движений)?")),
  });

  const cardQuery = useQuery({
    queryKey: ["material-card-group", groupKey],
    queryFn: () => getMaterialCardByGroup(groupKey!.material, groupKey!.color, groupKey!.thickness),
    enabled: !!groupKey,
  });

  // Раздел про выбор конкретного склада на карточке материала — units уже
  // несут warehouse_name (см. byWarehouse ниже), но раньше это можно было
  // только посмотреть, а не отфильтровать. Тот же хук, что уже даёт выбор
  // склада в "Остатках"/"Отчётах"; сопоставляем выбранный id с именем
  // склада, потому что MaterialUnitOut отдаёт только имя, не id.
  const { warehouseId, picker: warehousePicker } = useWarehouseFilter();
  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });
  const selectedWarehouseName = warehousesQuery.data?.find((w) => w.id === warehouseId)?.name;

  const scopedUnits = useMemo(() => {
    const units = cardQuery.data?.units ?? [];
    if (!selectedWarehouseName) return units;
    return units.filter((u) => u.warehouse_name === selectedWarehouseName);
  }, [cardQuery.data, selectedWarehouseName]);

  const byWidth = useMemo(() => {
    const groups = new Map<number, { width_mm: number; length_m: number; locations: Set<string> }>();
    for (const u of scopedUnits) {
      const g = groups.get(u.width_mm) ?? { width_mm: u.width_mm, length_m: 0, locations: new Set() };
      g.length_m += u.length_m;
      g.locations.add(u.location_code ?? u.area ?? "—");
      groups.set(u.width_mm, g);
    }
    return [...groups.values()].sort((a, b) => b.width_mm - a.width_mm);
  }, [scopedUnits]);

  // Раздел про остатки по складам в карточке материала — раньше был один
  // общий "Общий остаток" без разбивки; warehouse_name уже приходит на
  // каждой единице (backend/app/api/material_cards.py, тот же приём, что
  // уже даёт search_units в "Остатках"). Показываем разбивку только когда
  // складов реально больше одного — если склад один (как у большинства
  // позиций), ничего визуально не меняется.
  const byWarehouse = useMemo(() => {
    if (!cardQuery.data) return [];
    const groups = new Map<string, { name: string; area_m2: number; count: number }>();
    for (const u of cardQuery.data.units) {
      const name = u.warehouse_name ?? "Без склада";
      const g = groups.get(name) ?? { name, area_m2: 0, count: 0 };
      g.area_m2 += (u.width_mm * u.length_m) / 1000;
      g.count += 1;
      groups.set(name, g);
    }
    return [...groups.values()].sort((a, b) => b.area_m2 - a.area_m2);
  }, [cardQuery.data]);

  const scopedTotalAreaM2 = useMemo(
    () => scopedUnits.reduce((sum, u) => sum + (u.width_mm * u.length_m) / 1000, 0),
    [scopedUnits],
  );

  const filteredUnits = useMemo(() => {
    return scopedUnits.filter(
      (u) => (minWidthFilter == null || u.width_mm >= minWidthFilter) && (minLengthFilter == null || u.length_m >= minLengthFilter),
    );
  }, [scopedUnits, minWidthFilter, minLengthFilter]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const u of scopedUnits) counts[u.status] = (counts[u.status] ?? 0) + 1;
    return counts;
  }, [scopedUnits]);

  // Раздел про недостающий разбор рулон/штрипс — is_strip уже есть на
  // каждой единице, тот же приём агрегации, что statusCounts выше.
  const rollStripCounts = useMemo(() => {
    const result = { rolls: 0, rollsLengthM: 0, strips: 0, stripsLengthM: 0 };
    for (const u of scopedUnits) {
      if (u.is_strip) {
        result.strips += 1;
        result.stripsLengthM += u.length_m;
      } else {
        result.rolls += 1;
        result.rollsLengthM += u.length_m;
      }
    }
    return result;
  }, [scopedUnits]);

  // Раздел про производителя внутри карточки материала (не отдельным
  // измерением) — верхний выбор теперь по ГРУППЕ материал+цвет+толщина,
  // не по отдельной позиции; несколько производителей одной группы
  // схлопываются в одну опцию (та же дедупликация, что уже делают
  // stock_summary/MaterialsExplorer.tsx на бэкенде/фронте остатков).
  const groupOptions = useMemo(() => {
    const groups = new Map<string, { material: string; color: string; thickness: number; anyActive: boolean }>();
    for (const s of skusQuery.data ?? []) {
      if (!showArchived && !s.is_active) continue;
      const key = `${s.material.name}|${s.color.name}|${s.thickness.value_mm}`;
      const g = groups.get(key) ?? { material: s.material.name, color: s.color.name, thickness: s.thickness.value_mm, anyActive: false };
      g.anyActive = g.anyActive || s.is_active;
      groups.set(key, g);
    }
    return [...groups.entries()]
      .map(([key, g]) => ({
        value: key,
        label: g.anyActive ? `${g.material}, ${g.color}, ${g.thickness} мм` : `${g.material}, ${g.color}, ${g.thickness} мм (в архиве)`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [skusQuery.data, showArchived]);

  const groupValue = groupKey ? `${groupKey.material}|${groupKey.color}|${groupKey.thickness}` : undefined;
  const selectGroup = (key: string) => {
    const [material, color, thicknessStr] = key.split("|");
    setGroupKey({ material, color, thickness: Number(thicknessStr) });
  };

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
          placeholder="Выберите материал"
          loading={skusQuery.isLoading}
          showSearch
          optionFilterProp="label"
          options={groupOptions}
          value={groupValue}
          onChange={selectGroup}
        />
        {warehousePicker && groupKey && <span style={{ marginLeft: 12 }}>{warehousePicker}</span>}

        {groupKey && (
          <Space direction="vertical" size="middle" style={{ marginTop: 16, width: "100%" }}>
            <ResponsiveTable<MaterialSku>
              tableKey="material-card-skus"
              lockedColumns={["Производитель"]}
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={skusInGroup}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "Производитель", render: (_, s) => s.manufacturer.name },
                {
                  title: "Код у поставщика",
                  render: (_, s) => (
                    <Input
                      disabled={!canEdit}
                      size="small"
                      style={{ width: 140 }}
                      value={editingBySku[s.id]?.supplier_code ?? s.supplier_code ?? ""}
                      onChange={(e) => setEditingBySku((v) => ({ ...v, [s.id]: { ...v[s.id], supplier_code: e.target.value } }))}
                    />
                  ),
                },
                {
                  title: "Родная ширина, мм",
                  render: (_, s) => (
                    <InputNumber
                      disabled={!canEdit}
                      size="small"
                      min={1}
                      value={editingBySku[s.id]?.native_width_mm ?? s.native_width_mm ?? undefined}
                      onChange={(v) => setEditingBySku((prev) => ({ ...prev, [s.id]: { ...prev[s.id], native_width_mm: v ?? undefined } }))}
                    />
                  ),
                },
                {
                  title: "Статус",
                  render: (_, s) => <Tag color={s.is_active ? "green" : "default"}>{s.is_active ? "Активна" : "В архиве"}</Tag>,
                },
                {
                  title: "",
                  render: (_, s) =>
                    canEdit && (
                      <Space size={4} wrap>
                        <Button
                          size="small"
                          disabled={!Object.keys(editingBySku[s.id] ?? {}).length}
                          loading={updateMutation.isPending}
                          onClick={() => updateMutation.mutate({ id: s.id, payload: editingBySku[s.id] ?? {} })}
                        >
                          Сохранить
                        </Button>
                        <Button size="small" onClick={() => updateMutation.mutate({ id: s.id, payload: { is_active: !s.is_active } })}>
                          {s.is_active ? "В архив" : "Восстановить"}
                        </Button>
                        <Button size="small" danger loading={deleteMutation.isPending} onClick={() => deleteMutation.mutate(s.id)}>
                          {user?.is_superuser ? "Удалить" : "Запросить удаление"}
                        </Button>
                        <Button size="small" onClick={() => setAnalogsTarget(s)}>
                          Аналоги/фото
                        </Button>
                        <Button size="small" onClick={() => setMergeTarget(s)}>
                          Объединить
                        </Button>
                      </Space>
                    ),
                },
              ]}
            />
            {!canEdit && (
              <Space wrap>
                {skusInGroup.map((s) => (
                  <Button key={s.id} size="small" onClick={() => setAnalogsTarget(s)}>
                    Аналоги/фото — {s.manufacturer.name}
                  </Button>
                ))}
              </Space>
            )}
            {canAddUnit && (
              <Button type="primary" onClick={() => setAddUnitOpen(true)}>
                + Добавить единицу
              </Button>
            )}
          </Space>
        )}
      </Card>

      {cardQuery.data && (
        <>
          <Card>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={12} md={8}>
                <Statistic
                  title={selectedWarehouseName ? `Остаток — ${selectedWarehouseName}` : "Общий остаток"}
                  value={selectedWarehouseName ? Math.round(scopedTotalAreaM2 * 100) / 100 : cardQuery.data.total_area_m2}
                  suffix="м²"
                />
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

          {byWarehouse.length > 1 && !selectedWarehouseName && (
            <Card title="По складам">
              <Row gutter={[16, 16]}>
                {byWarehouse.map((w) => (
                  <Col xs={12} sm={8} md={6} key={w.name}>
                    <Statistic
                      title={w.name}
                      value={Math.round(w.area_m2 * 100) / 100}
                      suffix={`м² · ${w.count} шт`}
                    />
                  </Col>
                ))}
              </Row>
            </Card>
          )}

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
                // Раздел про производителя внутри карточки материала (не
                // отдельным измерением) — единицы разных производителей
                // теперь вперемешку в одном списке, эта колонка — единственное
                // место, где видно, чья это конкретно единица.
                { title: "Производитель", render: (_, u) => u.material_sku.manufacturer.name },
                { title: "Ширина×длина", render: (_, u) => `${u.width_mm}×${u.length_m}` },
                { title: "Статус", dataIndex: "status" },
                { title: "Склад", render: (_, u) => u.warehouse_name ?? "—" },
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

      {analogsTarget && (
        <SkuAnalogsModal sku={analogsTarget} allSkus={skusQuery.data ?? []} onClose={() => setAnalogsTarget(null)} canEdit={canEdit} />
      )}

      {reassignTarget && <ReassignSkuModal unit={reassignTarget} onClose={() => setReassignTarget(null)} />}
      {addUnitOpen && groupKey && <AddUnitModal group={groupKey} skusInGroup={skusInGroup} onClose={() => setAddUnitOpen(false)} />}
      {mergeTarget && (
        <MergeSkuModal sku={mergeTarget} allSkus={skusQuery.data ?? []} onClose={() => setMergeTarget(null)} />
      )}
    </Space>
  );
}

/** Добавить ещё одну физическую единицу этого материала прямо с карточки
 * (раздел про недостающую возможность) — материал/цвет/толщина уже
 * зафиксированы группой карточки, но производитель — больше не один на
 * карточку (раздел про производителя внутри карточки материала), поэтому
 * спрашиваем его явно: предвыбираем, если в группе всего один, иначе
 * пусто (можно ввести и нового — find_or_create_sku на бэкенде сам
 * заведёт под него позицию). Тот же приём, что "Единица плёнки вне сессии
 * приёмки" в MaterialsExplorer.tsx — receiveAndAutoPlace, без нового
 * бэкенд-эндпоинта. */
function AddUnitModal({
  group,
  skusInGroup,
  onClose,
}: {
  group: { material: string; color: string; thickness: number };
  skusInGroup: MaterialSku[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form] = Form.useForm<{
    manufacturer: string;
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
      manufacturer: string;
      is_strip: boolean;
      width_mm: number;
      length_m: number;
      upd_number?: string;
      pallet_number?: string;
      occurred_at?: Dayjs | null;
    }) =>
      receiveAndAutoPlace({
        material: group.material,
        color: group.color,
        thickness: group.thickness,
        manufacturer: v.manufacturer,
        is_strip: v.is_strip,
        width_mm: v.width_mm,
        length_m: v.length_m,
        upd_number: v.upd_number?.trim() || "Без документа",
        pallet_number: v.pallet_number?.trim() || "-",
        quantity: 1,
        occurred_at: toOccurredAtIso(v.occurred_at),
      }),
    onSuccess: (units) => {
      qc.invalidateQueries({ queryKey: ["material-card-group"] });
      qc.invalidateQueries({ queryKey: ["material-skus"] });
      setCreatedUnits(units);
      form.resetFields();
      message.success(`Единица №${units[0].id} зарегистрирована`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось зарегистрировать единицу")),
  });

  return (
    <Modal
      title={`Добавить единицу — ${group.material}, ${group.color}, ${group.thickness} мм`}
      open
      onCancel={onClose}
      footer={null}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ is_strip: false, manufacturer: skusInGroup.length === 1 ? skusInGroup[0].manufacturer.name : undefined }}
        onFinish={(v) => addMutation.mutate(v)}
      >
        <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
          <DictAutoComplete kind="manufacturers" />
        </Form.Item>
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
