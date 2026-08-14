import { useState } from "react";
import { Card, Table, Tag, Button, Modal, Form, InputNumber, Input, Select, Space, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listProductModels,
  createProductModel,
  updateProductModel,
  addProductModelPart,
  deleteProductModelPart,
  updateProductModelPart,
  deleteProductModel,
  type ProductModel,
  type ProductModelPart,
  type ProductModelPartCreate,
} from "../../api/production";
import type { AreaValue } from "../../api/units";
import { listAreas } from "../../api/areas";

/** Модели продукции (BOM) — вынесены из "Заданий цеха" в отдельный пункт
 * меню (раздел про адаптацию меню под планшет и разделение "конфигурации"
 * и "ежедневной работы"): состав модели трогают редко, при постановке
 * нового изделия в производство, а не каждый день, в отличие от самих
 * заданий/плана. Логически ближе к "Справочникам", но не сведена в тот же
 * экран — там плоские списки значений, тут вложенная таблица деталей. */
export default function ProductModels() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ProductModel | null>(null);
  const [partModalOpen, setPartModalOpen] = useState(false);
  const [editingPart, setEditingPart] = useState<ProductModelPart | null>(null);
  const [form] = Form.useForm<{ name: string; area: string }>();
  const [partForm] = Form.useForm<ProductModelPartCreate>();

  const modelsQuery = useQuery({ queryKey: ["product-models"], queryFn: listProductModels });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));

  const createMutation = useMutation({
    mutationFn: createProductModel,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product-models"] });
      setCreateOpen(false);
      form.resetFields();
      message.success("Модель создана");
    },
    onError: () => message.error("Не удалось создать — название уже занято?"),
  });

  const deleteModelMutation = useMutation({
    mutationFn: (id: number) => deleteProductModel(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product-models"] });
      message.success("Модель удалена");
    },
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => updateProductModel(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["product-models"] }),
  });

  const savePartMutation = useMutation({
    mutationFn: (payload: ProductModelPartCreate) =>
      editingPart
        ? updateProductModelPart(selectedModel!.id, editingPart.id, payload)
        : addProductModelPart(selectedModel!.id, payload),
    onSuccess: (part) => {
      qc.invalidateQueries({ queryKey: ["product-models"] });
      setSelectedModel((m) => {
        if (!m) return m;
        const exists = m.parts.some((p) => p.id === part.id);
        const parts = exists ? m.parts.map((p) => (p.id === part.id ? part : p)) : [...m.parts, part];
        return { ...m, parts };
      });
      setPartModalOpen(false);
      setEditingPart(null);
      partForm.resetFields();
      message.success(editingPart ? "Деталь обновлена" : "Деталь добавлена");
    },
    onError: () => message.error("Не удалось сохранить деталь"),
  });

  const deletePartMutation = useMutation({
    mutationFn: (partId: number) => deleteProductModelPart(selectedModel!.id, partId),
    onSuccess: (_, partId) => {
      qc.invalidateQueries({ queryKey: ["product-models"] });
      setSelectedModel((m) => (m ? { ...m, parts: m.parts.filter((p) => p.id !== partId) } : m));
      message.success("Деталь удалена из состава");
    },
  });

  const openAddPart = () => {
    setEditingPart(null);
    partForm.resetFields();
    partForm.setFieldsValue({ area: selectedModel?.area });
    setPartModalOpen(true);
  };

  const openEditPart = (part: ProductModelPart) => {
    setEditingPart(part);
    partForm.setFieldsValue({
      part_name: part.part_name ?? undefined,
      area: part.area,
      width_mm: part.width_mm,
      length_m: part.length_m,
      strip_width_mm: part.strip_width_mm ?? undefined,
      qty_per_unit: part.qty_per_unit,
    });
    setPartModalOpen(true);
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Модели продукции"
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            Добавить модель
          </Button>
        }
      >
        <Table<ProductModel>
          rowKey="id"
          loading={modelsQuery.isLoading}
          dataSource={modelsQuery.data ?? []}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            {
              title: "Название",
              dataIndex: "name",
              render: (v, m) => (
                <Button type="link" onClick={() => setSelectedModel(m)}>
                  {v}
                </Button>
              ),
            },
            { title: "Участок", dataIndex: "area", render: (v: string) => areaLabel(v) },
            { title: "Деталей в BOM", render: (_, m) => m.parts.length },
            {
              title: "Состав BOM",
              render: (_, m) => (
                <Button size="small" type="primary" ghost onClick={() => setSelectedModel(m)}>
                  ⚙️ Состав модели ({m.parts.length})
                </Button>
              ),
            },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (v: boolean) => (v ? <Tag color="green">Активна</Tag> : <Tag>В архиве</Tag>),
            },
            {
              title: "Действия",
              render: (_, m) => (
                <Space>
                  <Button size="small" onClick={() => archiveMutation.mutate({ id: m.id, is_active: !m.is_active })}>
                    {m.is_active ? "В архив" : "Восстановить"}
                  </Button>
                  <Button size="small" danger onClick={() => deleteModelMutation.mutate(m.id)}>
                    🗑️ Удалить
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* Модальное окно просмотра и редактирования состава модели (BOM) */}
      <Modal
        title={selectedModel ? `⚙️ Состав детализации BOM «${selectedModel.name}» (${areaLabel(selectedModel.area)})` : ""}
        open={!!selectedModel}
        onCancel={() => setSelectedModel(null)}
        width={800}
        footer={[
          <Button key="add" type="primary" onClick={openAddPart}>
            + Добавить деталь в состав
          </Button>,
          <Button key="close" onClick={() => setSelectedModel(null)}>
            Закрыть
          </Button>,
        ]}
      >
        {selectedModel && (
          <Table
            rowKey="id"
            dataSource={selectedModel.parts}
            pagination={false}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Деталь", dataIndex: "part_name", render: (v: string | null) => v ?? "—" },
              { title: "Участок", dataIndex: "area", render: (v: string) => areaLabel(v) },
              {
                title: "Штрипс (укутка), мм",
                dataIndex: "strip_width_mm",
                render: (v: number | null, p) => (
                  <Tag color="blue">{v ?? p.width_mm} мм</Tag>
                ),
              },
              { title: "Размер детали", render: (_, p) => `${p.width_mm} мм × ${p.length_m} м` },
              { title: "Кол-во на 1 дверь", dataIndex: "qty_per_unit" },
              {
                title: "Действия",
                render: (_, p) => (
                  <Space>
                    <Button size="small" onClick={() => openEditPart(p)}>
                      Редактировать
                    </Button>
                    <Button size="small" danger onClick={() => deletePartMutation.mutate(p.id)}>
                      Удалить
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Modal>

      <Modal title="Новая модель продукции" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form layout="vertical" form={form} onFinish={(v) => createMutation.mutate(v as { name: string; area: AreaValue })}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input placeholder="Дверь царговая, Прованс" />
          </Form.Item>
          <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
            <Select options={areaOptions} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      {/* Модальное окно создания/редактирования детали BOM */}
      <Modal
        title={editingPart ? "Редактировать деталь BOM" : "Новая деталь BOM"}
        open={partModalOpen}
        onCancel={() => {
          setPartModalOpen(false);
          setEditingPart(null);
        }}
        footer={null}
        destroyOnHidden
      >
        <Form layout="vertical" form={partForm} onFinish={(v) => savePartMutation.mutate(v)}>
          <Form.Item name="part_name" label="Название детали (Стоевая / Поперечная / Планка)">
            <Input
              placeholder="Стоевая 36х110"
              onChange={(e) => {
                const val = e.target.value.toLowerCase();
                if (val.includes("стоевая")) partForm.setFieldValue("strip_width_mm", 292);
                else if (val.includes("поперечная")) partForm.setFieldValue("strip_width_mm", 285);
                else if (val.includes("планка")) partForm.setFieldValue("strip_width_mm", 140);
              }}
            />
          </Form.Item>
          <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
            <Select options={areaOptions} />
          </Form.Item>
          <Form.Item name="width_mm" label="Ширина детали (мм)" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="strip_width_mm" label="Ширина штрипса плёнки для укутки (мм)" help="Авторасчёт: Стоевая 292 мм, Поперечная 285 мм, Планка 140/100 мм">
            <InputNumber min={1} style={{ width: "100%" }} placeholder="292" />
          </Form.Item>
          <Form.Item name="length_m" label="Длина детали с допуском (м)" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={0.1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="qty_per_unit" label="Количество деталей на 1 дверь" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={savePartMutation.isPending}>
            {editingPart ? "Сохранить изменения" : "Добавить деталь"}
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
