import { Button, Card, Form, InputNumber, Typography, Table } from "antd";
import { useMutation } from "@tanstack/react-query";
import { searchUnits, skuLabel, type MaterialUnit, type SearchParams } from "../../api/units";
import DictAutoComplete from "../../components/DictAutoComplete";

export default function Search() {
  const mutation = useMutation({ mutationFn: (params: SearchParams) => searchUnits(params) });

  return (
    <Card>
      <Typography.Title level={4}>Поиск остатка</Typography.Title>
      <Form layout="vertical" onFinish={(values) => mutation.mutate(values)}>
        <Form.Item name="material" label="Материал">
          <DictAutoComplete kind="materials" />
        </Form.Item>
        <Form.Item name="color" label="Цвет">
          <DictAutoComplete kind="colors" />
        </Form.Item>
        <Form.Item name="thickness" label="Толщина, мм">
          <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="manufacturer" label="Производитель">
          <DictAutoComplete kind="manufacturers" />
        </Form.Item>
        <Form.Item name="width_mm" label="Ширина, мм">
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="min_length_m" label="Минимальная длина, м">
          <InputNumber min={0} step={0.1} style={{ width: "100%" }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mutation.isPending}>
          Найти
        </Button>
      </Form>

      <Table<MaterialUnit>
        style={{ marginTop: 16 }}
        rowKey="id"
        size="small"
        dataSource={mutation.data ?? []}
        pagination={{ pageSize: 10 }}
        locale={{ emptyText: mutation.isSuccess ? "Ничего не найдено" : "Задайте фильтры и нажмите «Найти»" }}
        columns={[
          { title: "ID", dataIndex: "id" },
          { title: "Материал/цвет/толщина", render: (_, u) => skuLabel(u.material_sku) },
          { title: "Ширина×длина", render: (_, u) => `${u.width_mm}×${u.length_m}` },
          { title: "Ячейка", dataIndex: "location_code", render: (v) => v ?? "—" },
        ]}
      />
    </Card>
  );
}
