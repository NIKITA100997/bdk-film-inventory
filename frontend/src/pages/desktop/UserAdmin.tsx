import { useState } from "react";
import { Card, Table, Tag, Button, Modal, Form, Input, Select, Space, Popconfirm, Typography, message } from "antd";
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
import type { Area, UserRole } from "../../auth/types";

const roleLabels: Record<UserRole, string> = {
  operator_sklada: "Оператор склада",
  kladovshchik: "Кладовщик",
  nachalnik_uchastka: "Начальник участка",
  nachalnik_tsekha: "Начальник цеха",
  logist: "Логист/руководитель",
  snabzhenets: "Снабженец/закупщик",
  admin: "Администратор",
};

const areaLabels: Record<Area, string> = {
  okutka_tsargovykh: "Окутка царговых",
  shchitovye_dveri: "Щитовые двери",
  tselnolistovye_dveri: "Цельнолистовые двери",
};

const roleOptions = Object.entries(roleLabels).map(([value, label]) => ({ value, label }));
const areaOptions = Object.entries(areaLabels).map(([value, label]) => ({ value, label }));

export default function UserAdmin() {
  const qc = useQueryClient();
  const [roleFilter, setRoleFilter] = useState<UserRole | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [tempPassword, setTempPassword] = useState<{ username: string; password: string } | null>(null);
  const [createForm] = Form.useForm<UserCreatePayload>();
  const [editForm] = Form.useForm<UserUpdatePayload>();
  const createRole = Form.useWatch("role", createForm);
  const editRole = Form.useWatch("role", editForm);

  const usersQuery = useQuery({ queryKey: ["users", "all"], queryFn: listAllUsers });

  const createMutation = useMutation({
    mutationFn: createUser,
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

  const filtered = (usersQuery.data ?? []).filter((u) => !roleFilter || u.role === roleFilter);

  return (
    <Card>
      <Typography.Title level={4}>Пользователи</Typography.Title>
      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          allowClear
          placeholder="Все роли"
          style={{ width: 220 }}
          options={roleOptions}
          value={roleFilter ?? undefined}
          onChange={(v) => setRoleFilter(v ?? null)}
        />
        <Button type="primary" onClick={() => setCreateOpen(true)}>
          Добавить пользователя
        </Button>
      </Space>

      <Table<UserSummary>
        rowKey="id"
        loading={usersQuery.isLoading}
        dataSource={filtered}
        pagination={{ pageSize: 20 }}
        columns={[
          { title: "ФИО", dataIndex: "full_name" },
          { title: "Логин", dataIndex: "username" },
          { title: "Роль", render: (_, u) => roleLabels[u.role] },
          { title: "Участок", render: (_, u) => (u.area ? areaLabels[u.area] : "—") },
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
                    editForm.setFieldsValue({ full_name: u.full_name, role: u.role, area: u.area ?? undefined });
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
        <Form form={createForm} layout="vertical" onFinish={(v) => createMutation.mutate(v)}>
          <Form.Item name="full_name" label="ФИО" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="username" label="Логин" rules={[{ required: true }]}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="role" label="Роль" rules={[{ required: true }]}>
            <Select options={roleOptions} />
          </Form.Item>
          {createRole === "nachalnik_uchastka" && (
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
          onFinish={(v) => editing && updateMutation.mutate({ id: editing.id, payload: v })}
        >
          <Form.Item name="full_name" label="ФИО" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="role" label="Роль" rules={[{ required: true }]}>
            <Select options={roleOptions} />
          </Form.Item>
          {editRole === "nachalnik_uchastka" && (
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
    </Card>
  );
}
