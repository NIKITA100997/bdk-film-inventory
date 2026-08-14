import { useState } from "react";
import { Link } from "react-router-dom";
import { Card, Tag, Button, Modal, Form, Input, Select, Checkbox, Space, Popconfirm, Typography, message } from "antd";
import ResponsiveTable from "../../components/ResponsiveTable";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listAllUsers,
  createUser,
  updateUser,
  resetUserPassword,
  type UserCreatePayload,
  type UserUpdatePayload,
} from "../../api/users";
import type { UserSummary } from "../../api/users";
import { listRoles, createRole } from "../../api/roles";
import { listAreas } from "../../api/areas";
import type { Area } from "../../auth/types";

type UserFormValues = {
  full_name: string;
  username?: string;
  role_ids: number[];
  is_superuser: boolean;
  area?: Area;
  password?: string;
};

export default function UserAdmin() {
  const qc = useQueryClient();
  const [roleFilter, setRoleFilter] = useState<number | null>(null);
  const [showDisabled, setShowDisabled] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);
  const [createForm] = Form.useForm<UserFormValues>();
  const [editForm] = Form.useForm<UserFormValues>();
  const createRoleIds = Form.useWatch("role_ids", createForm) ?? [];
  const editRoleIds = Form.useWatch("role_ids", editForm) ?? [];

  const [roleCreateFor, setRoleCreateFor] = useState<"create" | "edit" | null>(null);
  const [newRoleForm] = Form.useForm<{ name: string }>();

  const usersQuery = useQuery({ queryKey: ["users", "all"], queryFn: listAllUsers });
  const rolesQuery = useQuery({ queryKey: ["roles"], queryFn: listRoles });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const roles = rolesQuery.data ?? [];
  const roleOptions = roles.map((r) => ({ value: r.id, label: r.name }));

  // Участок — независимый атрибут (8.3 раздел бэклога доработок), но
  // поле показываем только когда среди выбранных ролей есть "начальник
  // участка" — определяем по системному коду, не по названию (роль могли
  // переименовать).
  const hasUchastkaRole = (roleIds: number[]) =>
    roles.some((r) => r.code === "nachalnik_uchastka" && roleIds.includes(r.id));

  const createMutation = useMutation({
    mutationFn: (payload: UserCreatePayload) => createUser(payload),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["users", "all"] });
      setCreateOpen(false);
      createForm.resetFields();
      setTempPassword({ username: result.user.username, password: result.temporary_password });
      message.success("Пользователь создан");
    },
    onError: () => message.error("Не удалось создать — логин уже занят?"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: UserUpdatePayload }) => updateUser(id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users", "all"] });
      setEditing(null);
      message.success("Сохранено");
    },
    onError: () => message.error("Не удалось сохранить"),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: (id: number) => resetUserPassword(id),
    onSuccess: (result, id) => {
      const target = (usersQuery.data ?? []).find((u) => u.id === id);
      setTempPassword({ username: target?.username ?? "", password: result.temporary_password });
    },
    onError: () => message.error("Не удалось сбросить пароль"),
  });

  // "+ Создать роль" прямо из формы пользователя (раздел разбора — раньше
  // роль без прав приходилось заводить на отдельном экране "Роли и права",
  // теряя контекст создания пользователя) — добавляет новую роль сразу в
  // список выбранных на той форме, с которой её вызвали.
  const createRoleMutation = useMutation({
    mutationFn: (name: string) => createRole(name),
    onSuccess: (role) => {
      qc.invalidateQueries({ queryKey: ["roles"] });
      const form = roleCreateFor === "edit" ? editForm : createForm;
      const current: number[] = form.getFieldValue("role_ids") ?? [];
      form.setFieldValue("role_ids", [...current, role.id]);
      setRoleCreateFor(null);
      newRoleForm.resetFields();
      message.success("Роль создана и добавлена в выбранные");
    },
    onError: () => message.error("Не удалось создать — название уже занято?"),
  });

  // Выдача суперправ — не рутинное редактирование (раздел разбора):
  // подтверждение перед отправкой формы, только когда флаг реально
  // включается (не при сохранении уже суперпользователя без изменений).
  const confirmSuperuserIfNeeded = (values: UserFormValues, wasSuperuser: boolean, onOk: () => void) => {
    if (values.is_superuser && !wasSuperuser) {
      Modal.confirm({
        title: "Выдать права суперпользователя?",
        content: "Полный доступ ко всей системе в обход ролей и прав. Можно будет отменить позже, сняв флажок.",
        okText: "Выдать",
        okButtonProps: { danger: true },
        cancelText: "Отмена",
        onOk,
      });
    } else {
      onOk();
    }
  };

  const filtered = (usersQuery.data ?? [])
    .filter((u) => !roleFilter || u.roles.some((r) => r.id === roleFilter))
    .filter((u) => showDisabled || u.is_active);

  return (
    <Card>
      <Space align="baseline" style={{ marginBottom: 4 }}>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Пользователи
        </Typography.Title>
        <Link to="/roles">Роли и права →</Link>
      </Space>
      <div style={{ marginBottom: 12 }} />
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder="Все роли"
          style={{ width: 220 }}
          options={roleOptions}
          value={roleFilter ?? undefined}
          onChange={(v) => setRoleFilter(v ?? null)}
        />
        <Checkbox checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)}>
          Показывать отключённых
        </Checkbox>
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          Добавить пользователя
        </Button>
      </Space>

      <ResponsiveTable<UserSummary>
        tableKey="users"
        lockedColumns={["ФИО"]}
        rowKey="id"
        loading={usersQuery.isLoading}
        dataSource={filtered}
        pagination={{ pageSize: 20 }}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "ФИО", dataIndex: "full_name" },
          { title: "Логин", dataIndex: "username" },
          {
            title: "Роль",
            render: (_, u) => (
              <Space size={4} wrap>
                {u.is_superuser && <Tag color="gold">Суперпользователь</Tag>}
                {u.roles.map((r) => (
                  <Tag key={r.id}>{r.name}</Tag>
                ))}
              </Space>
            ),
          },
          { title: "Участок", render: (_, u) => (u.area ? areaLabel(u.area) : "—") },
          {
            title: "Статус",
            render: (_, u) => (u.is_active ? <Tag color="green">Активен</Tag> : <Tag>Отключён</Tag>),
          },
          {
            title: "",
            render: (_, u) => (
              <Space>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(u);
                    editForm.setFieldsValue({
                      full_name: u.full_name,
                      role_ids: u.roles.map((r) => r.id),
                      is_superuser: u.is_superuser,
                      area: u.area ?? undefined,
                    });
                  }}
                >
                  Изменить
                </Button>
                <Popconfirm title="Сбросить пароль?" description="Будет выдан новый временный пароль." onConfirm={() => resetPasswordMutation.mutate(u.id)}>
                  <Button size="small">Сбросить пароль</Button>
                </Popconfirm>
                <Button
                  size="small"
                  danger={u.is_active}
                  onClick={() => updateMutation.mutate({ id: u.id, payload: { is_active: !u.is_active } })}
                >
                  {u.is_active ? "Отключить" : "Включить"}
                </Button>
              </Space>
            ),
          },
        ]}
      />

      <Modal title="Новый пользователь" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form
          form={createForm}
          layout="vertical"
          initialValues={{ role_ids: [], is_superuser: false }}
          onFinish={(v) =>
            confirmSuperuserIfNeeded(v, false, () =>
              createMutation.mutate({ ...v, username: v.username ?? "", area: hasUchastkaRole(v.role_ids) ? v.area : undefined }),
            )
          }
        >
          <Form.Item name="full_name" label="ФИО" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="username" label="Логин" rules={[{ required: true }]}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item label="Роли">
            <Space.Compact block>
              <Form.Item name="role_ids" noStyle>
                <Select mode="multiple" options={roleOptions} loading={rolesQuery.isLoading} style={{ width: "100%" }} />
              </Form.Item>
              <Button onClick={() => setRoleCreateFor("create")}>+ Роль</Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item name="is_superuser" valuePropName="checked">
            <Checkbox>Суперпользователь (полный доступ, минуя роли)</Checkbox>
          </Form.Item>
          {hasUchastkaRole(createRoleIds) && (
            <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
              <Select options={areaOptions} />
            </Form.Item>
          )}
          <Form.Item name="password" label="Временный пароль (необязательно)">
            <Input autoComplete="off" placeholder="Оставьте пустым — сгенерируется автоматически" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal title={`Изменить: ${editing?.full_name ?? ""}`} open={!!editing} onCancel={() => setEditing(null)} footer={null} destroyOnHidden>
        <Form
          form={editForm}
          layout="vertical"
          onFinish={(v) =>
            confirmSuperuserIfNeeded(v, editing?.is_superuser ?? false, () =>
              editing && updateMutation.mutate({ id: editing.id, payload: { ...v, area: hasUchastkaRole(v.role_ids) ? v.area : null } }),
            )
          }
        >
          <Form.Item name="full_name" label="ФИО" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="Роли">
            <Space.Compact block>
              <Form.Item name="role_ids" noStyle>
                <Select mode="multiple" options={roleOptions} loading={rolesQuery.isLoading} style={{ width: "100%" }} />
              </Form.Item>
              <Button onClick={() => setRoleCreateFor("edit")}>+ Роль</Button>
            </Space.Compact>
          </Form.Item>
          <Form.Item name="is_superuser" valuePropName="checked">
            <Checkbox>Суперпользователь (полный доступ, минуя роли)</Checkbox>
          </Form.Item>
          {hasUchastkaRole(editRoleIds) && (
            <Form.Item name="area" label="Участок" rules={[{ required: true }]}>
              <Select options={areaOptions} />
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" block loading={updateMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>

      <Modal
        title="Временный пароль"
        open={!!tempPassword}
        onCancel={() => setTempPassword(null)}
        footer={<Button type="primary" onClick={() => setTempPassword(null)}>Готово</Button>}
      >
        <Typography.Paragraph>
          Логин <b>{tempPassword?.username}</b> — временный пароль показывается один раз, передайте его сотруднику:
        </Typography.Paragraph>
        <Typography.Paragraph copyable style={{ fontSize: 20, fontFamily: "monospace" }}>
          {tempPassword?.password}
        </Typography.Paragraph>
      </Modal>

      <Modal
        title="Новая роль"
        open={!!roleCreateFor}
        onCancel={() => setRoleCreateFor(null)}
        footer={null}
        destroyOnHidden
      >
        <Form form={newRoleForm} layout="vertical" onFinish={(v) => createRoleMutation.mutate(v.name)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
            Права роли настраиваются отдельно, в «Роли и права» — здесь только название, роль сразу добавится к выбранным.
          </Typography.Paragraph>
          <Button type="primary" htmlType="submit" block loading={createRoleMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>
    </Card>
  );
}
