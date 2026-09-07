import { useState } from "react";
import { Card, Space, Typography, Button, Modal, Form, Input, InputNumber, Select, Checkbox, Tag, Empty, Popconfirm, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import ResponsiveTable from "../../components/ResponsiveTable";
import {
  listAllParts,
  listPartDuplicates,
  createPart,
  updatePart,
  updatePartStages,
  type Part,
  type PartCreate,
  type DuplicateCandidate,
} from "../../api/dictionaries";
import { listAreas } from "../../api/areas";

/** Справочник деталей (раздел про выбор детали в задание) — физическая
 * форма детали (ширина/длина/ширина штрипса плёнки), выбирается при
 * создании строки BOM (ProductModels.tsx) или задания (CreateTaskModal.tsx)
 * вместо перепечатывания одних и тех же размеров каждый раз. Отдельная
 * страница, не вкладка в "Справочниках" (DictionaryAdmin.tsx) — та гейтится
 * materials.manage, а деталь логически относится к производству/BOM, тем
 * же правом (production_tasks.manage), что и "Модели продукции" рядом. */
export default function PartsAdmin() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editingPart, setEditingPart] = useState<Part | null>(null);
  const [form] = Form.useForm<PartCreate>();
  // Раздел про физический учёт деталей (пилот: окутка царговых) — свой
  // упорядоченный список этапов у каждой детали отдельно (не общий enum),
  // редактируется здесь же, в справочнике "Деталь".
  const [stagesTarget, setStagesTarget] = useState<Part | null>(null);
  const [stageRows, setStageRows] = useState<{ code: string; name: string; area: string | null }[]>([]);

  const partsQuery = useQuery({ queryKey: ["parts", "all"], queryFn: listAllParts });
  const duplicatesQuery = useQuery({ queryKey: ["parts", "duplicates"], queryFn: listPartDuplicates });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "Общая (все участки)");
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));

  const invalidateCaches = () => {
    qc.invalidateQueries({ queryKey: ["parts"] });
    qc.invalidateQueries({ queryKey: ["dict-autocomplete", "parts"] });
  };

  const saveMutation = useMutation({
    mutationFn: (payload: PartCreate) =>
      (editingPart ? updatePart(editingPart.id, { ...payload, area: payload.area ?? null }) : createPart(payload)),
    onSuccess: (saved) => {
      invalidateCaches();
      setCreateOpen(false);
      setEditingPart(null);
      form.resetFields();
      const synced = saved.synced_task_lines ?? 0;
      message.success(
        editingPart
          ? synced > 0
            ? `Деталь обновлена — размер подтянулся в ${synced} ${synced === 1 ? "строку" : "строк"} активных заданий`
            : "Деталь обновлена"
          : "Деталь добавлена",
      );
    },
    onError: () => message.error("Не удалось сохранить — название уже занято?"),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => updatePart(id, { is_active }),
    onSuccess: () => invalidateCaches(),
  });

  const stagesMutation = useMutation({
    mutationFn: () => updatePartStages(stagesTarget!.id, stageRows),
    onSuccess: () => {
      invalidateCaches();
      message.success("Этапы сохранены");
      setStagesTarget(null);
    },
    onError: () => message.error("Не удалось сохранить этапы"),
  });

  const openStages = (part: Part) => {
    setStagesTarget(part);
    setStageRows(part.stages.map((s) => ({ code: s.code, name: s.name, area: s.area })));
  };
  const moveStage = (index: number, delta: number) => {
    setStageRows((rows) => {
      const next = [...rows];
      const target = index + delta;
      if (target < 0 || target >= next.length) return rows;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };
  const removeStage = (index: number) => setStageRows((rows) => rows.filter((_, i) => i !== index));
  const addStage = () => setStageRows((rows) => [...rows, { code: "", name: "", area: null }]);
  // Раздел про "этапы = участки производства" — этап это не своё название
  // плюс отдельно привязанный участок, а буквально выбор участка: код и
  // имя этапа всегда зеркалят код и имя выбранного участка, отдельного
  // текстового названия у этапа больше нет.
  const updateStageArea = (index: number, area: string | null) =>
    setStageRows((rows) =>
      rows.map((r, i) => {
        if (i !== index) return r;
        const picked = areasQuery.data?.find((a) => a.code === area);
        return { code: picked?.code ?? "", name: picked?.name ?? "", area };
      }),
    );

  const openCreate = () => {
    setEditingPart(null);
    form.resetFields();
    setCreateOpen(true);
  };

  const openEdit = (part: Part) => {
    setEditingPart(part);
    form.setFieldsValue({
      name: part.name,
      width_mm: part.width_mm,
      length_m: part.length_m,
      strip_width_mm: part.strip_width_mm ?? undefined,
      area: part.area ?? undefined,
    });
    setCreateOpen(true);
  };

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Справочник деталей — здесь. Рядом: <a onClick={() => navigate("/product-models")}>Модели продукции (BOM)</a> ·{" "}
        <a onClick={() => navigate("/production-lines")}>Линии цеха</a>
      </Typography.Paragraph>
      <Card
        title="Детали (справочник)"
        extra={
          <Space>
            <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
              Показывать архивные
            </Checkbox>
            <Button type="primary" onClick={openCreate}>
              + Добавить деталь
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          Готовые размеры детали (ширина/длина/ширина штрипса плёнки для укутки) — подсказка при создании строки
          состава модели или производственного задания, чтобы не вводить одни и те же числа заново.
        </Typography.Paragraph>
        <ResponsiveTable<Part>
          tableKey="parts-admin"
          lockedColumns={["Название"]}
          rowKey="id"
          loading={partsQuery.isLoading}
          dataSource={(partsQuery.data ?? []).filter((p) => showArchived || p.is_active)}
          pagination={{ pageSize: 20 }}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name" },
            { title: "Ширина, мм", dataIndex: "width_mm" },
            { title: "Длина на списание, м", dataIndex: "length_m" },
            {
              title: "Штрипс (укутка), мм",
              dataIndex: "strip_width_mm",
              render: (v: number | null) => (v != null ? <Tag color="blue">{v} мм</Tag> : "—"),
            },
            { title: "Участок", dataIndex: "area", render: (v: string | null) => areaLabel(v) },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (active: boolean) => (active ? <Tag color="green">Активна</Tag> : <Tag>В архиве</Tag>),
            },
            {
              // Раздел про физический учёт деталей (пилот: окутка царговых)
              // — пусто = партию п/ф для этой детали завести нельзя, пока
              // не настроены этапы.
              title: "Этапы (учёт п/ф)",
              render: (_, p) =>
                p.stages.length === 0 ? (
                  <Typography.Text type="secondary">не настроены</Typography.Text>
                ) : (
                  <Space size={4} wrap>
                    {p.stages.map((s) => (
                      <Tag key={s.id}>{s.name}</Tag>
                    ))}
                  </Space>
                ),
            },
            {
              title: "",
              render: (_, p) => (
                <Space>
                  <Button size="small" onClick={() => openEdit(p)}>
                    Редактировать
                  </Button>
                  <Button size="small" onClick={() => openStages(p)}>
                    Настроить этапы
                  </Button>
                  <Button size="small" onClick={() => archiveMutation.mutate({ id: p.id, is_active: !p.is_active })}>
                    {p.is_active ? "В архив" : "Восстановить"}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title="Возможные дубликаты" loading={duplicatesQuery.isLoading}>
        {(duplicatesQuery.data ?? []).length === 0 ? (
          <Empty description="Похожих названий не найдено" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <ResponsiveTable<DuplicateCandidate>
            rowKey={(d) => `${d.a_id}-${d.b_id}`}
            size="small"
            pagination={false}
            dataSource={duplicatesQuery.data}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Деталь A", dataIndex: "a_name" },
              { title: "Деталь B", dataIndex: "b_name" },
              { title: "Похожесть", dataIndex: "score", render: (v: number) => `${Math.round(v * 100)}%` },
              {
                title: "",
                render: (_, d) => (
                  <Popconfirm
                    title={`Архивировать «${d.b_name}»?`}
                    description="Деталь останется в системе для старых записей, но пропадёт из подсказок."
                    onConfirm={() => archiveMutation.mutate({ id: d.b_id, is_active: false })}
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

      <Modal
        title={editingPart ? "Редактировать деталь" : "Новая деталь"}
        open={createOpen}
        onCancel={() => {
          setCreateOpen(false);
          setEditingPart(null);
        }}
        footer={null}
        destroyOnHidden
      >
        <Form layout="vertical" form={form} onFinish={(v) => saveMutation.mutate(v)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input placeholder="Наличник 8х70х2150" autoFocus />
          </Form.Item>
          <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="length_m" label="Длина на списание, с допуском (м)" rules={[{ required: true }]}>
            <InputNumber min={0.01} step={0.1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="strip_width_mm" label="Ширина штрипса плёнки для укутки, мм (опционально)">
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="area" label="Участок (опционально — пусто значит общая для всех)">
            <Select allowClear options={areaOptions} placeholder="Общая для всех участков" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={saveMutation.isPending}>
            {editingPart ? "Сохранить изменения" : "Добавить деталь"}
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`Этапы детали «${stagesTarget?.name ?? ""}»`}
        open={!!stagesTarget}
        onCancel={() => setStagesTarget(null)}
        footer={null}
        destroyOnHidden
      >
        <Typography.Paragraph type="secondary">
          Порядок сверху вниз — путь, который проходит партия этой детали по цеху (участок за участком). Пусто —
          физический учёт для этой детали ещё не включён. Этап — это участок: выдача партии на этом этапе выводится
          отсюда же, вручную выбирать участок отдельно больше не нужно.
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          {stageRows.map((row, i) => (
            <Space key={i} style={{ width: "100%" }}>
              <Typography.Text type="secondary" style={{ width: 20 }}>
                {i + 1}.
              </Typography.Text>
              <Select
                showSearch
                style={{ width: 260 }}
                placeholder="Выберите участок"
                options={areaOptions}
                value={row.area ?? undefined}
                onChange={(v) => updateStageArea(i, v)}
                filterOption={(input, option) => (option?.label ?? "").toLowerCase().includes(input.toLowerCase())}
              />
              <Button size="small" disabled={i === 0} onClick={() => moveStage(i, -1)}>
                ↑
              </Button>
              <Button size="small" disabled={i === stageRows.length - 1} onClick={() => moveStage(i, 1)}>
                ↓
              </Button>
              <Button size="small" danger onClick={() => removeStage(i)}>
                Убрать
              </Button>
            </Space>
          ))}
          <Button block onClick={addStage}>
            + Добавить этап
          </Button>
          <Button
            type="primary"
            block
            loading={stagesMutation.isPending}
            onClick={() => {
              if (stageRows.some((r) => !r.area)) {
                message.warning("У каждого этапа должен быть выбран участок");
                return;
              }
              stagesMutation.mutate();
            }}
          >
            Сохранить этапы
          </Button>
        </Space>
      </Modal>
    </Space>
  );
}
