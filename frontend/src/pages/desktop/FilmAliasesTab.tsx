import { useState } from "react";
import { Button, Checkbox, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listMaterialSkus } from "../../api/dictionaries";
import { createFilmAlias, deleteFilmAlias, listFilmAliases, updateFilmAlias, type FilmAlias } from "../../api/filmAliases";
import { apiErrorMessage } from "../../utils/apiError";

/** Сопоставления плёнки: как плёнку называют во внешних источниках (графики
 * запуска, наряды, планы заготовок, 1С) → позиция справочника. Общие для всей
 * программы: подбор плёнки по тексту сначала смотрит сюда. Импорт графика
 * дополняет список сам, когда плёнку выбирают вручную. */
export default function FilmAliasesTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["film-aliases"], queryFn: listFilmAliases });
  const skusQuery = useQuery({ queryKey: ["material-skus", "active"], queryFn: () => listMaterialSkus(false) });
  const skuOptions = (skusQuery.data ?? [])
    .filter((s) => s.is_active && s.thickness.value_mm > 0)
    .map((s) => ({ value: s.id, label: `${s.material.name} ${s.color.name} ${s.thickness.value_mm} мм · ${s.manufacturer.name}` }))
    .sort((a, b) => a.label.localeCompare(b.label, "ru"));
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<FilmAlias | "new" | null>(null);
  const [form] = Form.useForm<{ text: string; material_sku_id: number; any_thickness: boolean }>();

  const save = useMutation({
    mutationFn: (v: { text: string; material_sku_id: number; any_thickness: boolean }) =>
      editing && editing !== "new" ? updateFilmAlias(editing.id, v) : createFilmAlias(v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["film-aliases"] });
      setEditing(null);
      message.success("Сохранено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  const remove = useMutation({
    mutationFn: deleteFilmAlias,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["film-aliases"] }),
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить")),
  });

  const needle = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter((a) => !needle || `${a.text} ${a.film}`.toLowerCase().includes(needle));
  const open = (a: FilmAlias | "new") => {
    setEditing(a);
    form.setFieldsValue(
      a === "new"
        ? { text: "", material_sku_id: undefined, any_thickness: false }
        : { text: a.text, material_sku_id: a.material_sku_id ?? undefined, any_thickness: a.any_thickness },
    );
  };

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Как плёнку называют в графиках запуска, нарядах, планах заготовок и 1С → позиция справочника. Работает во всей
        программе: подбор плёнки по тексту сначала смотрит сюда. Импорт графика сам дополняет список, когда плёнку
        выбирают вручную. Регистр, «ё» и пояснение в скобках не важны.
      </Typography.Paragraph>
      <Space wrap>
        <Input.Search allowClear placeholder="Текст или плёнка" style={{ width: 320 }} onChange={(e) => setSearch(e.target.value)} />
        <Button type="primary" onClick={() => open("new")}>
          Добавить сопоставление
        </Button>
      </Space>
      <Table<FilmAlias>
        size="small"
        rowKey="id"
        loading={q.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        columns={[
          { title: "Как написано в источнике", dataIndex: "text" },
          {
            title: "Плёнка",
            render: (_, a) => (
              <Space size={6} wrap>
                <span>{a.film}</span>
                {a.any_thickness && <Tag>любая толщина</Tag>}
                {!a.has_stock_sku && <Tag color="red">нет активной позиции</Tag>}
              </Space>
            ),
          },
          { title: "Источник", dataIndex: "source", render: (v: string | null) => <Typography.Text type="secondary">{v ?? "—"}</Typography.Text> },
          {
            title: "",
            width: 170,
            render: (_, a) => (
              <Space>
                <Button size="small" onClick={() => open(a)}>
                  Изменить
                </Button>
                <Popconfirm title="Удалить сопоставление?" onConfirm={() => remove.mutate(a.id)}>
                  <Button size="small" danger>
                    Удалить
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={editing != null}
        title={editing === "new" ? "Новое сопоставление" : "Сопоставление"}
        okText="Сохранить"
        confirmLoading={save.isPending}
        onCancel={() => setEditing(null)}
        onOk={() => form.validateFields().then((v) => save.mutate(v))}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="text" label="Как написано в источнике" rules={[{ required: true, message: "Введите текст" }]}>
            <Input placeholder="Например: Bolton Oak" />
          </Form.Item>
          <Form.Item name="material_sku_id" label="Плёнка справочника" rules={[{ required: true, message: "Выберите плёнку" }]}>
            <Select showSearch optionFilterProp="label" options={skuOptions} loading={skusQuery.isLoading} placeholder="Материал, цвет, толщина" />
          </Form.Item>
          <Form.Item name="any_thickness" valuePropName="checked" style={{ marginBottom: 0 }}>
            <Checkbox>Любая толщина этой плёнки</Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
