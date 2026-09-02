import { useState } from "react";
import { Card, Tag, Button, Modal, Form, Input, Select, Space, Typography, Checkbox, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import { listAreas, createArea, updateArea, type Area } from "../../api/areas";
import { listSites, createSite, updateSite, type Site } from "../../api/sites";
import { listWarehouses } from "../../api/storage";
import ResponsiveTable from "../../components/ResponsiveTable";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

/** Участки (раздел про адаптацию под планшет — "администрирование
 * участков, какие есть и т.п.") — раньше жёсткий enum, теперь создаваемая
 * администратором сущность, тот же паттерн, что "Роли и права": название
 * редактируется, код (стабильный идентификатор в базе) выводится сервером
 * из названия и не меняется.
 *
 * Площадки (раздел про площадки, 2026-08-28) — у компании физически две
 * площадки (Северный/Фабрика), каждая с ровно одним домашним складом;
 * участок опционально привязан к площадке, чтобы при выдаче плёнки можно
 * было предупредить, если она физически лежит не на "своём" складе (см.
 * Issue.tsx). Площадки администрируются на этой же странице, тем же
 * паттерном CRUD, что и сами участки. */
export default function AreaAdmin() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<{ name: string; site_id?: number; requires_daily_plan?: boolean }>();
  const [editing, setEditing] = useState<Area | null>(null);
  const [editForm] = Form.useForm<{ name: string; site_id?: number; requires_daily_plan?: boolean }>();
  const [showArchived, setShowArchived] = useState(false);

  const [siteCreateOpen, setSiteCreateOpen] = useState(false);
  const [siteCreateForm] = Form.useForm<{ name: string; warehouse_id: number }>();
  const [editingSite, setEditingSite] = useState<Site | null>(null);
  const [siteEditForm] = Form.useForm<{ name: string; warehouse_id: number }>();

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: listSites });
  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });

  const siteLabel = (siteId: number | null) => (sitesQuery.data ?? []).find((s) => s.id === siteId)?.name ?? "—";
  const warehouseLabel = (warehouseId: number) => (warehousesQuery.data ?? []).find((w) => w.id === warehouseId)?.name ?? "—";

  const createMutation = useMutation({
    mutationFn: (v: { name: string; site_id?: number; requires_daily_plan?: boolean }) =>
      createArea(v.name, v.site_id, v.requires_daily_plan),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["areas"] });
      setCreateOpen(false);
      createForm.resetFields();
      message.success("Участок создан");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать участок")),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ code, is_active }: { code: string; is_active: boolean }) => updateArea(code, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["areas"] });
      message.success("Сохранено");
    },
  });

  const editMutation = useMutation({
    mutationFn: (v: { name: string; site_id?: number; requires_daily_plan?: boolean }) =>
      updateArea(editing!.code, { name: v.name, site_id: v.site_id ?? null, requires_daily_plan: v.requires_daily_plan }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["areas"] });
      setEditing(null);
      message.success("Сохранено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить участок")),
  });

  const createSiteMutation = useMutation({
    mutationFn: (v: { name: string; warehouse_id: number }) => createSite(v.name, v.warehouse_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sites"] });
      setSiteCreateOpen(false);
      siteCreateForm.resetFields();
      message.success("Площадка создана");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать площадку")),
  });

  const editSiteMutation = useMutation({
    mutationFn: (v: { name: string; warehouse_id: number }) => updateSite(editingSite!.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sites"] });
      setEditingSite(null);
      message.success("Сохранено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить площадку")),
  });

  const archiveSiteMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => updateSite(id, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sites"] });
      message.success("Сохранено");
    },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Площадки"
        extra={
          <Button type="primary" onClick={() => setSiteCreateOpen(true)}>
            Добавить площадку
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Физическая площадка (Северный/Фабрика) — у каждой ровно один домашний склад. Участки ниже привязываются к
          площадке, чтобы на «Выдаче» можно было предупредить, если плёнка физически лежит не на своём складе.
        </Typography.Paragraph>
        <ResponsiveTable<Site>
          tableKey="sites"
          lockedColumns={["Название"]}
          rowKey="id"
          loading={sitesQuery.isLoading}
          dataSource={sitesQuery.data ?? []}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name" },
            { title: "Домашний склад", render: (_, s) => warehouseLabel(s.warehouse_id) },
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
                    onClick={() => {
                      setEditingSite(s);
                      siteEditForm.setFieldsValue({ name: s.name, warehouse_id: s.warehouse_id });
                    }}
                  >
                    Изменить
                  </Button>
                  <Button size="small" onClick={() => archiveSiteMutation.mutate({ id: s.id, is_active: !s.is_active })}>
                    {s.is_active ? "В архив" : "Восстановить"}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="Участки"
        extra={
          <Space>
            <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
              Показывать архивные
            </Checkbox>
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              Добавить участок
            </Button>
          </Space>
        }
      >
        <ResponsiveTable<Area>
          tableKey="areas"
          lockedColumns={["Название"]}
          rowKey="code"
          loading={areasQuery.isLoading}
          dataSource={(areasQuery.data ?? []).filter((a) => showArchived || a.is_active)}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name" },
            { title: "Код", dataIndex: "code", render: (v: string) => <Typography.Text type="secondary">{v}</Typography.Text> },
            { title: "Площадка", render: (_, a) => siteLabel(a.site_id) },
            {
              title: "Планирование",
              dataIndex: "requires_daily_plan",
              render: (v: boolean) => (v ? <Tag color="blue">По дням</Tag> : <Tag>Просто на участок</Tag>),
            },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (v: boolean) => (v ? <Tag color="green">Активен</Tag> : <Tag>В архиве</Tag>),
            },
            {
              title: "",
              render: (_, a) => (
                <Space>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditing(a);
                      editForm.setFieldsValue({
                        name: a.name,
                        site_id: a.site_id ?? undefined,
                        requires_daily_plan: a.requires_daily_plan,
                      });
                    }}
                  >
                    Изменить
                  </Button>
                  <Button size="small" onClick={() => archiveMutation.mutate({ code: a.code, is_active: !a.is_active })}>
                    {a.is_active ? "В архив" : "Восстановить"}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal title="Новый участок" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form
          form={createForm}
          layout="vertical"
          initialValues={{ requires_daily_plan: true }}
          onFinish={(v) => createMutation.mutate(v)}
        >
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus placeholder="Раскрой ПВХ" />
          </Form.Item>
          <Form.Item name="site_id" label="Площадка (опционально)">
            <Select
              allowClear
              loading={sitesQuery.isLoading}
              options={(sitesQuery.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
          <Form.Item name="requires_daily_plan" valuePropName="checked">
            <Checkbox>Разбивка по дням/бригадам (мастер распределяет через «План на день»)</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Если выключить — задания участка планируются просто на участок, без «Распределить»/«План на день»,
            и на выдаче не помечаются как «не распределено».
          </Typography.Paragraph>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal title={`Изменить «${editing?.name ?? ""}»`} open={!!editing} onCancel={() => setEditing(null)} footer={null} destroyOnHidden>
        <Form form={editForm} layout="vertical" onFinish={(v) => editMutation.mutate(v)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="site_id" label="Площадка (опционально)">
            <Select
              allowClear
              loading={sitesQuery.isLoading}
              options={(sitesQuery.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
          <Form.Item name="requires_daily_plan" valuePropName="checked">
            <Checkbox>Разбивка по дням/бригадам (мастер распределяет через «План на день»)</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Если выключить — задания участка планируются просто на участок, без «Распределить»/«План на день»,
            и на выдаче не помечаются как «не распределено».
          </Typography.Paragraph>
          <Button type="primary" htmlType="submit" block loading={editMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>

      <Modal title="Новая площадка" open={siteCreateOpen} onCancel={() => setSiteCreateOpen(false)} footer={null} destroyOnHidden>
        <Form form={siteCreateForm} layout="vertical" onFinish={(v) => createSiteMutation.mutate(v)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus placeholder="Северный" />
          </Form.Item>
          <Form.Item name="warehouse_id" label="Домашний склад" rules={[{ required: true }]}>
            <Select
              loading={warehousesQuery.isLoading}
              options={(warehousesQuery.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createSiteMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`Изменить «${editingSite?.name ?? ""}»`}
        open={!!editingSite}
        onCancel={() => setEditingSite(null)}
        footer={null}
        destroyOnHidden
      >
        <Form form={siteEditForm} layout="vertical" onFinish={(v) => editSiteMutation.mutate(v)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="warehouse_id" label="Домашний склад" rules={[{ required: true }]}>
            <Select
              loading={warehousesQuery.isLoading}
              options={(warehousesQuery.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={editSiteMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
