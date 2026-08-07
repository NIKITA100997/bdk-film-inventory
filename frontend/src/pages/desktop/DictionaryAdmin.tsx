import { useState } from "react";
import { Card, Tabs, Table, Button, Input, InputNumber, Tag, Space, Popconfirm, Typography, Empty, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listAllNameDict,
  listNameDictDuplicates,
  updateNameDictEntry,
  listAllThicknesses,
  updateThicknessEntry,
  type NameDictKind,
  type DictEntry,
  type DuplicateCandidate,
  type ThicknessEntry,
} from "../../api/dictionaries";

function NameDictTab({ kind, label }: { kind: NameDictKind; label: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Record<number, string>>({});

  const entriesQuery = useQuery({ queryKey: [kind, "all"], queryFn: () => listAllNameDict(kind) });
  const duplicatesQuery = useQuery({ queryKey: [kind, "duplicates"], queryFn: () => listNameDictDuplicates(kind) });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: { name?: string; is_active?: boolean } }) =>
      updateNameDictEntry(kind, id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [kind, "all"] });
      qc.invalidateQueries({ queryKey: [kind, "duplicates"] });
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
      qc.invalidateQueries({ queryKey: ["thicknesses", "all"] });
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
      <Typography.Title level={4}>Справочники — материалы, цвета, толщины, производители</Typography.Title>
      <Typography.Paragraph type="secondary">
        Архивные значения пропадают из подсказок при вводе, но не удаляются — старые записи, где они уже
        использованы, остаются читаемыми.
      </Typography.Paragraph>
      <Tabs
        items={[
          { key: "materials", label: "Материалы", children: <NameDictTab kind="materials" label="Материал" /> },
          { key: "colors", label: "Цвета", children: <NameDictTab kind="colors" label="Цвет" /> },
          { key: "manufacturers", label: "Производители", children: <NameDictTab kind="manufacturers" label="Производитель" /> },
          { key: "thicknesses", label: "Толщины", children: <ThicknessTab /> },
        ]}
      />
    </Card>
  );
}
