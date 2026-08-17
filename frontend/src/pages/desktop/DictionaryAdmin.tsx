import { useState } from "react";
import { Card, Tabs, Button, Input, InputNumber, Tag, Space, Popconfirm, Typography, Empty, Checkbox, Modal, Form, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../components/ResponsiveTable";
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
import {
  listAllWriteOffReasons,
  createWriteOffReason,
  updateWriteOffReason,
  type WriteOffReasonEntry,
} from "../../api/writeOffReasons";

function NameDictTab({ kind, label }: { kind: NameDictKind; label: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Record<number, string>>({});
  const [showArchived, setShowArchived] = useState(false);

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
      <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
        Показывать архивные
      </Checkbox>
      <ResponsiveTable<DictEntry>
        rowKey="id"
        loading={entriesQuery.isLoading}
        dataSource={(entriesQuery.data ?? []).filter((e) => showArchived || e.is_active)}
        pagination={false}
        scroll={{ x: "max-content" }}
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
          <ResponsiveTable<DuplicateCandidate>
            rowKey={(d) => `${d.a_id}-${d.b_id}`}
            size="small"
            pagination={false}
            dataSource={duplicatesQuery.data}
            scroll={{ x: "max-content" }}
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
  const [showArchived, setShowArchived] = useState(false);
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
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
        Показывать архивные
      </Checkbox>
      <ResponsiveTable<ThicknessEntry>
      rowKey="id"
      loading={entriesQuery.isLoading}
      dataSource={(entriesQuery.data ?? []).filter((e) => showArchived || e.is_active)}
      pagination={false}
      scroll={{ x: "max-content" }}
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
    </Space>
  );
}

/** Причины брака/списания (раздел про администрирование причин) — раньше
 * жёсткий enum, теперь создаваемая администратором сущность, тот же
 * паттерн, что «Участки» (AreaAdmin.tsx): название редактируется, code
 * (стабильный идентификатор в базе, на него ссылаются MaterialEvent и
 * ProductionTaskLineReport) выводится сервером из названия и не
 * меняется. В отличие от остальных вкладок этого экрана — с созданием:
 * причины не заводятся неявно через свободный ввод где-то ещё, только
 * явным действием тут. "Отход при раскрое" — системная (проставляется
 * только автоматически при продольной резке), без кнопок
 * переименовать/архивировать. */
function WriteOffReasonsTab() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<{ name: string }>();
  const [renaming, setRenaming] = useState<WriteOffReasonEntry | null>(null);
  const [renameForm] = Form.useForm<{ name: string }>();
  const [showArchived, setShowArchived] = useState(false);

  const reasonsQuery = useQuery({ queryKey: ["write-off-reasons", "all"], queryFn: listAllWriteOffReasons });

  const createMutation = useMutation({
    mutationFn: (name: string) => createWriteOffReason(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["write-off-reasons"] });
      setCreateOpen(false);
      createForm.resetFields();
      message.success("Причина создана");
    },
    onError: () => message.error("Не удалось создать — название уже занято?"),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ code, is_active }: { code: string; is_active: boolean }) => updateWriteOffReason(code, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["write-off-reasons"] });
      message.success("Сохранено");
    },
  });

  const renameMutation = useMutation({
    mutationFn: (name: string) => updateWriteOffReason(renaming!.code, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["write-off-reasons"] });
      setRenaming(null);
      message.success("Переименовано");
    },
    onError: () => message.error("Не удалось переименовать — название уже занято?"),
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Space style={{ width: "100%", justifyContent: "space-between" }}>
        <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
          Показывать архивные
        </Checkbox>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          Добавить причину
        </Button>
      </Space>
      <ResponsiveTable<WriteOffReasonEntry>
        tableKey="write-off-reasons"
        lockedColumns={["Название"]}
        rowKey="code"
        loading={reasonsQuery.isLoading}
        dataSource={(reasonsQuery.data ?? []).filter((r) => showArchived || r.is_active)}
        pagination={false}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "Название", dataIndex: "name" },
          {
            title: "Статус",
            width: 220,
            render: (_, r) =>
              r.is_system ? (
                <Tag color="blue">Системная</Tag>
              ) : r.is_active ? (
                <Tag color="green">Активна</Tag>
              ) : (
                <Tag>В архиве</Tag>
              ),
          },
          {
            title: "",
            width: 220,
            render: (_, r) =>
              r.is_system ? (
                <Typography.Text type="secondary" style={{ fontSize: 12.5 }}>
                  выставляется автоматически при раскрое
                </Typography.Text>
              ) : (
                <Space>
                  <Button
                    size="small"
                    onClick={() => {
                      setRenaming(r);
                      renameForm.setFieldsValue({ name: r.name });
                    }}
                  >
                    Переименовать
                  </Button>
                  <Button size="small" onClick={() => archiveMutation.mutate({ code: r.code, is_active: !r.is_active })}>
                    {r.is_active ? "В архив" : "Восстановить"}
                  </Button>
                </Space>
              ),
          },
        ]}
      />

      <Modal title="Новая причина" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form form={createForm} layout="vertical" onFinish={(v) => createMutation.mutate(v.name)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus placeholder="Пересорт" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`Переименовать «${renaming?.name ?? ""}»`}
        open={!!renaming}
        onCancel={() => setRenaming(null)}
        footer={null}
        destroyOnHidden
      >
        <Form form={renameForm} layout="vertical" onFinish={(v) => renameMutation.mutate(v.name)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={renameMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}

/** Справочники (2.1a ТЗ) — только атомарные составляющие позиции материала
 * (материал/цвет/производитель/толщина), не сама номенклатура. Раньше здесь
 * же была вкладка "Номенклатура" — таблица позиций (материал+цвет+толщина+
 * производитель), дублировавшая список на "Остатках"; по итогам продуктового
 * разбора объединены — редактирование позиции (код у поставщика, родная
 * ширина, архив, аналоги/фото) переехало в карточку материала
 * (MaterialCard.tsx), куда и так уже вёл клик по строке на "Остатках". */
export default function DictionaryAdmin() {
  return (
    <Card>
      <Typography.Title level={4}>Справочники</Typography.Title>
      <Typography.Paragraph type="secondary">
        Архивные значения пропадают из подсказок при вводе, но не удаляются — старые записи, где они уже
        использованы, остаются читаемыми. Саму номенклатуру (позиции материала) редактируйте в карточке материала —
        откройте её кликом по строке на «Остатках».
      </Typography.Paragraph>
      <Tabs
        items={[
          { key: "materials", label: "Материалы (тип)", children: <NameDictTab kind="materials" label="Материал" /> },
          { key: "colors", label: "Цвета", children: <NameDictTab kind="colors" label="Цвет" /> },
          { key: "manufacturers", label: "Производители", children: <NameDictTab kind="manufacturers" label="Производитель" /> },
          { key: "thicknesses", label: "Толщины", children: <ThicknessTab /> },
          { key: "write-off-reasons", label: "Причины брака/списания", children: <WriteOffReasonsTab /> },
        ]}
      />
    </Card>
  );
}
