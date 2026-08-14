import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, Tag, Button, Modal, Form, Input, Checkbox, Space, Typography, message } from "antd";
import ResponsiveTable from "../../components/ResponsiveTable";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listRoles, createRole, updateRole, updateRolePermissions, listPermissions, type Role } from "../../api/roles";

/** Роли и права (8.3 раздел бэклога доработок) — роли создаются и
 * переименовываются здесь, права у роли — чекбоксы из фиксированного
 * каталога, сгруппированные по разделу. Суперпользователь (админ) сюда не
 * заходит — это отдельный флаг на пользователе, не роль. */
export default function RoleAdmin() {
  const qc = useQueryClient();
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<{ name: string }>();
  const [checkedIds, setCheckedIds] = useState<number[]>([]);

  const rolesQuery = useQuery({ queryKey: ["roles"], queryFn: listRoles });
  const permissionsQuery = useQuery({ queryKey: ["permissions"], queryFn: listPermissions });
  const selectedRole = (rolesQuery.data ?? []).find((r) => r.id === selectedRoleId) ?? null;

  useEffect(() => {
    setCheckedIds(selectedRole?.permissions.map((p) => p.id) ?? []);
  }, [selectedRole?.id, selectedRole?.permissions]);

  const createMutation = useMutation({
    mutationFn: (name: string) => createRole(name),
    onSuccess: (role) => {
      qc.invalidateQueries({ queryKey: ["roles"] });
      setCreateOpen(false);
      createForm.resetFields();
      setSelectedRoleId(role.id);
      message.success("Роль создана");
    },
    onError: () => message.error("Не удалось создать — название уже занято?"),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => updateRole(id, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["roles"] });
      message.success("Сохранено");
    },
  });

  const savePermissionsMutation = useMutation({
    mutationFn: () => updateRolePermissions(selectedRoleId!, checkedIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["roles"] });
      message.success("Права сохранены");
    },
  });

  const sections = Array.from(new Set((permissionsQuery.data ?? []).map((p) => p.section)));

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Space align="baseline">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Роли и права
        </Typography.Title>
        <Link to="/users">← Пользователи</Link>
      </Space>

      <Card
        title="Роли"
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            Создать роль
          </Button>
        }
      >
        <ResponsiveTable<Role>
          rowKey="id"
          loading={rolesQuery.isLoading}
          dataSource={rolesQuery.data ?? []}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name", render: (v, r) => <a onClick={() => setSelectedRoleId(r.id)}>{v}</a> },
            { title: "Прав назначено", render: (_, r) => r.permissions.length },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (v: boolean) => (v ? <Tag color="green">Активна</Tag> : <Tag>В архиве</Tag>),
            },
            {
              title: "",
              render: (_, r) => (
                <Button size="small" onClick={() => archiveMutation.mutate({ id: r.id, is_active: !r.is_active })}>
                  {r.is_active ? "В архив" : "Восстановить"}
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {selectedRole && (
        <Card
          title={`Права роли «${selectedRole.name}»`}
          extra={
            <Button type="primary" onClick={() => savePermissionsMutation.mutate()} loading={savePermissionsMutation.isPending}>
              Сохранить
            </Button>
          }
          loading={permissionsQuery.isLoading}
        >
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            {sections.map((section) => {
              const sectionPermissions = (permissionsQuery.data ?? []).filter((p) => p.section === section);
              return (
                <div key={section}>
                  <Typography.Text strong>{section}</Typography.Text>
                  <div style={{ marginTop: 8 }}>
                    <Checkbox.Group
                      value={checkedIds.filter((id) => sectionPermissions.some((p) => p.id === id))}
                      onChange={(values) => {
                        const otherSectionsChecked = checkedIds.filter((id) => !sectionPermissions.some((p) => p.id === id));
                        setCheckedIds([...otherSectionsChecked, ...(values as number[])]);
                      }}
                    >
                      <Space direction="vertical">
                        {sectionPermissions.map((p) => (
                          <Checkbox key={p.id} value={p.id}>
                            {p.name}
                          </Checkbox>
                        ))}
                      </Space>
                    </Checkbox.Group>
                  </div>
                </div>
              );
            })}
          </Space>
        </Card>
      )}

      <Modal title="Новая роль" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form form={createForm} layout="vertical" onFinish={(v) => createMutation.mutate(v.name)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
