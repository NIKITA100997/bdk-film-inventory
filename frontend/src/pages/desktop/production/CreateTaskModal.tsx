import { useState } from "react";
import { Modal, Form, Select, InputNumber, Input, Button, Upload, Table, Typography, Space, Tabs, message } from "antd";
import { isAxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listProductModels,
  createProductionTaskManual,
  parseNaryadFile,
  parseBlankPlan,
  type BlankPlanBlock,
  type ProductionTaskLineManualCreate,
} from "../../../api/production";
import { listMaterialSkus } from "../../../api/dictionaries";
import { skuLabel, type AreaValue, type MaterialSku } from "../../../api/units";
import { listAreas } from "../../../api/areas";
import PartSelect from "../../../components/PartSelect";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

type ManualRowFormValues = ProductionTaskLineManualCreate & { sku_id?: number };

/** Создание производственного задания — из состава модели (BOM), из
 * наряд-заказа (.xls) или вручную, в один и тот же редактируемый список
 * строк. Вынесено в свой компонент (раздел 16 бэклога доработок —
 * ProductionTasks.tsx разросся до 889 строк, это был самый большой кусок,
 * ~160 строк) — самодостаточен, сам тянет модели/участки/номенклатуру по
 * своим query-ключам (тот же кэш React Query, что и у остального
 * приложения, лишних запросов не добавляет). */
export default function CreateTaskModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [manualLines, setManualLines] = useState<ProductionTaskLineManualCreate[]>([]);
  const [manualForm] = Form.useForm<{ name: string; area: AreaValue; external_order_ref?: number }>();
  const [manualRowForm] = Form.useForm<ManualRowFormValues>();
  const [bomForm] = Form.useForm<{ product_model_id: number; quantity: number }>();
  // Общий выбор номенклатуры для обоих способов массовой загрузки строк
  // (из состава модели и из наряд-заказа) — оба означают один и тот же
  // выбор: какую плёнку подставить в загружаемые строки (ни BOM, ни файл
  // наряд-заказа плёнку не знают, только форму деталей). "Добавить строку
  // вручную" ниже — отдельный, самостоятельный выбор (там материал реально
  // может отличаться от строки к строке).
  const [selectedSkuId, setSelectedSkuId] = useState<number>();
  // Раздел про импорт плана заготовок (Excel) — в отличие от BOM/наряда,
  // цвет свой у каждой строки: материал подбирается построчно уже на
  // сервере (не через общий selectedSkuId), поэтому свой стейт вместо
  // переиспользования того же поля.
  const [blankPlanBlocks, setBlankPlanBlocks] = useState<BlankPlanBlock[]>([]);
  const [selectedBlockIndex, setSelectedBlockIndex] = useState<number>();

  const modelsQuery = useQuery({ queryKey: ["product-models"], queryFn: listProductModels });
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const skuOptions = (skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }));
  const activeModels = (modelsQuery.data ?? []).filter((m) => m.is_active && m.parts.length > 0);
  const bomProductModelId = Form.useWatch("product_model_id", bomForm);

  const applySkuFields = (form: typeof manualRowForm, sku: MaterialSku | undefined) => {
    if (!sku) return;
    form.setFieldsValue({ material: sku.material.name, color: sku.color.name, thickness: sku.thickness.value_mm });
  };

  const resetAndClose = () => {
    manualForm.resetFields();
    manualRowForm.resetFields();
    bomForm.resetFields();
    setSelectedSkuId(undefined);
    setManualLines([]);
    setBlankPlanBlocks([]);
    setSelectedBlockIndex(undefined);
    onClose();
  };

  // Незаполненные обязательные поля (деталь не подобралась — нет
  // width_mm/length_m, или материал не подобрался — нет material/color/
  // thickness) — раздел про импорт плана заготовок: такие строки не
  // проходят через форму "Добавить строку" (там уже есть required-
  // валидация), а добавляются напрямую из разобранного файла, где
  // подсказка может не найтись. Строку нельзя отправить в задание, пока
  // её не поправят через "Изменить" ниже.
  const isLineComplete = (l: ProductionTaskLineManualCreate) =>
    !!l.material && !!l.color && l.thickness > 0 && l.width_mm > 0 && l.length_m > 0 && l.quantity_pieces > 0;
  const hasIncompleteLines = manualLines.some((l) => !isLineComplete(l));

  const manualCreateMutation = useMutation({
    mutationFn: createProductionTaskManual,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      resetAndClose();
      message.success("Задание создано");
    },
    onError: () => message.error("Не удалось создать задание"),
  });

  const loadLinesFromBom = () => {
    if (!selectedSkuId) return;
    bomForm
      .validateFields()
      .then(({ product_model_id, quantity }) => {
        const model = activeModels.find((m) => m.id === product_model_id);
        const sku = skusQuery.data?.find((s) => s.id === selectedSkuId);
        if (!model || !sku) return;
        const loaded: ProductionTaskLineManualCreate[] = model.parts.map((p) => ({
          material: sku.material.name,
          color: sku.color.name,
          thickness: sku.thickness.value_mm,
          quantity_pieces: p.qty_per_unit * quantity,
          width_mm: p.width_mm,
          length_m: p.length_m,
          strip_width_mm: p.strip_width_mm ?? undefined,
          part_name: p.part_name ?? undefined,
        }));
        setManualLines((lines) => [...lines, ...loaded]);
        manualForm.setFieldsValue({
          name: manualForm.getFieldValue("name") || `${model.name} — ${quantity} шт`,
          area: model.area,
        });
        manualRowForm.setFieldsValue({ sku_id: selectedSkuId });
        applySkuFields(manualRowForm, sku);
      })
      .catch(() => {});
  };

  // Раздел про загрузку наряд-заказа — печатная форма («Перечень деталей
  // столярных изделий») даёт только форму деталей, без плёнки: тот же
  // sku_id, что выбран здесь, подставляется в material/color/thickness
  // каждой распознанной строки, ровно как loadLinesFromBom подставляет
  // его для строк из состава модели.
  const parseNaryadMutation = useMutation({
    mutationFn: parseNaryadFile,
    onSuccess: (result) => {
      const sku = skusQuery.data?.find((s) => s.id === selectedSkuId);
      if (!sku) return;
      const loaded: ProductionTaskLineManualCreate[] = result.lines.map((l) => ({
        material: sku.material.name,
        color: sku.color.name,
        thickness: sku.thickness.value_mm,
        quantity_pieces: l.quantity_pieces,
        width_mm: l.width_mm,
        length_m: l.length_m,
        strip_width_mm: l.strip_width_mm ?? undefined,
        part_name: l.part_name,
      }));
      setManualLines((lines) => [...lines, ...loaded]);
      manualForm.setFieldsValue({
        name: manualForm.getFieldValue("name") || result.suggested_name,
        external_order_ref: manualForm.getFieldValue("external_order_ref") ?? result.order_number ?? undefined,
      });
      message.success(`Из наряд-заказа добавлено строк: ${loaded.length}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось разобрать файл наряд-заказа")),
  });

  // Раздел про импорт плана заготовок (Excel) — лист планирования окутки/
  // раскроя на дату («Номенклатура/Цвет/.../Заказ»), с цветом отдельно у
  // каждой строки (в отличие от наряд-заказа/BOM — там плёнка одна на всё
  // задание). Подбор детали/материала — уже на сервере
  // (services.blank_plan_import.enrich_blank_plan_blocks); здесь только
  // раскладываем результат по строкам, что не подобралось — 0/пусто, и
  // такую строку не даст отправить isLineComplete выше.
  const parseBlankPlanMutation = useMutation({
    mutationFn: parseBlankPlan,
    onSuccess: (result) => {
      setBlankPlanBlocks(result.blocks);
      setSelectedBlockIndex(result.blocks.length > 0 ? 0 : undefined);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось разобрать файл плана заготовок")),
  });

  const loadBlankPlanBlock = () => {
    if (selectedBlockIndex === undefined) return;
    const block = blankPlanBlocks[selectedBlockIndex];
    if (!block) return;
    const loaded: ProductionTaskLineManualCreate[] = block.lines.map((l) => ({
      material: l.material ?? "",
      color: l.color_raw,
      thickness: l.thickness ?? 0,
      quantity_pieces: l.quantity_pieces,
      width_mm: l.width_mm ?? 0,
      length_m: l.length_m ?? 0,
      strip_width_mm: l.strip_width_mm ?? undefined,
      part_name: l.part_name,
    }));
    setManualLines((lines) => [...lines, ...loaded]);
    manualForm.setFieldsValue({ name: manualForm.getFieldValue("name") || block.suggested_name });
    message.success(`Из блока «${block.suggested_name}» добавлено строк: ${loaded.length}`);
  };

  const addManualLine = (v: ManualRowFormValues) => {
    const { sku_id: _skuId, ...rest } = v;
    setManualLines((lines) => [...lines, rest]);
    const defaultSkuId = selectedSkuId;
    manualRowForm.resetFields();
    if (defaultSkuId) {
      manualRowForm.setFieldsValue({ sku_id: defaultSkuId });
      applySkuFields(manualRowForm, skusQuery.data?.find((s) => s.id === defaultSkuId));
    }
  };
  const removeManualLine = (index: number) => setManualLines((lines) => lines.filter((_, i) => i !== index));

  // Строка уходит из таблицы в форму "Добавить строку" ниже для правки
  // (например, деталь/материал не подобрались при импорте плана
  // заготовок) — не привязано к конкретному источнику строки, работает
  // для любой уже добавленной строки.
  const editManualLine = (index: number) => {
    manualRowForm.setFieldsValue(manualLines[index]);
    removeManualLine(index);
  };

  return (
    <Modal
      title="Новое производственное задание"
      open={open}
      onCancel={resetAndClose}
      footer={null}
      destroyOnHidden
      width="95vw"
      style={{ maxWidth: 1400, top: 16 }}
    >
      <Typography.Paragraph type="secondary">
        Строки задания — общий редактируемый список ниже, независимо от того, откуда они взялись: загрузите их из
        файла (вкладка «Загрузить из файла») или добавляйте по одной вручную (вкладка «Добавить вручную») — можно и
        то, и другое по очереди. Линия не выбирается здесь — задание ставится на участок, а по линиям/дням/сотрудникам
        его распределяет начальник участка отдельно (кнопка «Распределить» у уже созданного задания).
      </Typography.Paragraph>

      <Tabs
        items={[
          {
            key: "file",
            label: "Загрузить из файла",
            children: (
              <>
                <Typography.Title level={5}>Материал для загружаемых строк</Typography.Title>
                <Typography.Paragraph type="secondary">
                  Общий выбор для способов ниже — из состава модели и из наряд-заказа (план заготовок подбирает
                  материал сам, построчно, свой у каждой строки).
                </Typography.Paragraph>
                <Select
                  showSearch
                  placeholder="Выберите позицию материала"
                  options={skuOptions}
                  optionFilterProp="label"
                  value={selectedSkuId}
                  onChange={setSelectedSkuId}
                  style={{ width: "100%", marginBottom: 24 }}
                />

                <Typography.Title level={5}>Начать из модели (BOM)</Typography.Title>
                <Form form={bomForm} layout="vertical">
                  <Form.Item name="product_model_id" label="Модель продукции" rules={[{ required: true }]}>
                    <Select
                      placeholder="Выберите модель"
                      options={activeModels.map((m) => ({ value: m.id, label: `${m.name} (${areaLabel(m.area)})` }))}
                      notFoundContent={<Typography.Text type="secondary">Нет моделей с заполненным BOM — заведите на вкладке «Модели продукции»</Typography.Text>}
                    />
                  </Form.Item>
                  <Form.Item name="quantity" label="Количество, шт" rules={[{ required: true }]}>
                    <InputNumber min={1} style={{ width: "100%" }} />
                  </Form.Item>
                  <Button block disabled={!bomProductModelId || !selectedSkuId} onClick={loadLinesFromBom}>
                    Загрузить строки из состава
                  </Button>
                </Form>

                <Typography.Title level={5} style={{ marginTop: 24 }}>
                  Загрузить наряд-заказ
                </Typography.Title>
                <Typography.Paragraph type="secondary">
                  Файл содержит только форму деталей (название/ширина/длина/кол-во) — материал выбирается общим полем выше.
                </Typography.Paragraph>
                <Upload
                  accept=".xls"
                  showUploadList={false}
                  disabled={!selectedSkuId}
                  beforeUpload={(file) => {
                    parseNaryadMutation.mutate(file);
                    return false;
                  }}
                >
                  <Button block disabled={!selectedSkuId} loading={parseNaryadMutation.isPending}>
                    Загрузить файл наряд-заказа (.xls)
                  </Button>
                </Upload>

                <Typography.Title level={5} style={{ marginTop: 24 }}>
                  Загрузить план заготовок
                </Typography.Title>
                <Typography.Paragraph type="secondary">
                  Лист планирования окутки/раскроя на дату (Номенклатура/Цвет/.../Заказ) — цвет свой у каждой строки,
                  материал подбирается автоматически там, где это однозначно; один файл может содержать несколько
                  блоков (бок о бок или на разных листах) — каждый блок становится отдельным заданием.
                </Typography.Paragraph>
                <Upload
                  accept=".xlsx"
                  showUploadList={false}
                  beforeUpload={(file) => {
                    parseBlankPlanMutation.mutate(file);
                    return false;
                  }}
                >
                  <Button block loading={parseBlankPlanMutation.isPending}>
                    Загрузить файл плана заготовок (.xlsx)
                  </Button>
                </Upload>
                {blankPlanBlocks.length > 0 && (
                  <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
                    <Select
                      style={{ flex: 1 }}
                      value={selectedBlockIndex}
                      onChange={setSelectedBlockIndex}
                      options={blankPlanBlocks.map((b, i) => ({
                        value: i,
                        label: `${b.sheet_name} — ${b.suggested_name} (${b.lines.length} строк)`,
                      }))}
                    />
                    <Button onClick={loadBlankPlanBlock} disabled={selectedBlockIndex === undefined}>
                      Загрузить строки блока
                    </Button>
                  </div>
                )}
              </>
            ),
          },
          {
            key: "manual",
            label: "Добавить вручную",
            children: (
              <Form form={manualRowForm} layout="vertical" onFinish={addManualLine}>
                <Form.Item label="Деталь из справочника (опционально)">
                  <PartSelect
                    area={Form.useWatch("area", manualForm)}
                    onSelect={(part) =>
                      manualRowForm.setFieldsValue({
                        part_name: part.name,
                        width_mm: part.width_mm,
                        length_m: part.length_m,
                        strip_width_mm: part.strip_width_mm ?? undefined,
                      })
                    }
                  />
                </Form.Item>
                <Form.Item name="part_name" label="Название детали (опционально)">
                  <Input placeholder="Стоевая" />
                </Form.Item>
                <Form.Item name="sku_id" label="Материал (номенклатура)" rules={[{ required: true }]}>
                  <Select
                    showSearch
                    placeholder="Выберите позицию материала"
                    options={skuOptions}
                    optionFilterProp="label"
                    onChange={(skuId) => applySkuFields(manualRowForm, skusQuery.data?.find((s) => s.id === skuId))}
                  />
                </Form.Item>
                <Form.Item name="material" hidden rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="color" hidden rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="thickness" hidden rules={[{ required: true }]}>
                  <InputNumber />
                </Form.Item>
                <Form.Item name="width_mm" label="Ширина детали, мм" rules={[{ required: true }]}>
                  <InputNumber min={1} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item name="length_m" label="Длина детали на списание, м" rules={[{ required: true }]}>
                  <InputNumber min={0.01} step={0.1} style={{ width: "100%" }} />
                </Form.Item>
                <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
                  <InputNumber min={1} style={{ width: "100%" }} />
                </Form.Item>
                <Button htmlType="submit" block>
                  Добавить строку в задание
                </Button>
              </Form>
            ),
          },
        ]}
      />

      <Typography.Title level={5} style={{ marginTop: 24 }}>
        Название и участок задания
      </Typography.Title>
      <Form layout="vertical" form={manualForm}>
        <Form.Item name="name" label="Название задания" rules={[{ required: true }]}>
          <Input placeholder="Партия 500 дверей" />
        </Form.Item>
        <Form.Item name="external_order_ref" label="№ заказа">
          <InputNumber style={{ width: "100%" }} placeholder="Заполняется автоматически из наряда, можно поправить" />
        </Form.Item>
        <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
          <Select options={areaOptions} />
        </Form.Item>
      </Form>

      {manualLines.length > 0 && (
        <>
          <Table
            rowKey={(_, i) => String(i)}
            size="small"
            pagination={false}
            dataSource={manualLines}
            style={{ marginBottom: hasIncompleteLines ? 8 : 16 }}
            scroll={{ x: "max-content" }}
            onRow={(l) => (isLineComplete(l) ? {} : { style: { background: "#fff1f0" } })}
            columns={[
              {
                title: "Деталь",
                render: (_, l) => (l.width_mm > 0 && l.length_m > 0 ? l.part_name ?? "—" : `${l.part_name ?? "—"} (не подобралась)`),
              },
              {
                title: "Материал",
                render: (_, l) => (l.material && l.color ? `${l.material}, ${l.color}, ${l.thickness} мм` : `цвет: ${l.color || "—"} (не подобран)`),
              },
              { title: "Ширина, мм", render: (_, l) => l.width_mm || "—" },
              { title: "Длина на списание, м", render: (_, l) => l.length_m || "—" },
              { title: "Кол-во, шт", dataIndex: "quantity_pieces" },
              {
                title: "",
                render: (_, __, index) => (
                  <Space size={4}>
                    <Button size="small" onClick={() => editManualLine(index)}>
                      Изменить
                    </Button>
                    <Button size="small" danger onClick={() => removeManualLine(index)}>
                      Убрать
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
          {hasIncompleteLines && (
            <Typography.Text type="danger" style={{ display: "block", marginBottom: 16 }}>
              Есть незаполненные строки (подсвечены) — нажмите «Изменить» и подберите деталь/материал, либо уберите строку.
            </Typography.Text>
          )}
        </>
      )}

      <Button
        type="primary"
        block
        style={{ marginTop: 16 }}
        disabled={manualLines.length === 0 || hasIncompleteLines}
        loading={manualCreateMutation.isPending}
        onClick={() => {
          manualForm
            .validateFields()
            .then((v) =>
              manualCreateMutation.mutate({
                ...v,
                product_model_id: bomProductModelId || undefined,
                quantity: bomForm.getFieldValue("quantity") || undefined,
                lines: manualLines,
              }),
            )
            .catch(() => {});
        }}
      >
        Создать задание ({manualLines.length} строк(и))
      </Button>
    </Modal>
  );
}
