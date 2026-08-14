import { useState } from "react";
import { Card, Tag, Button, Modal, Form, Input, Space, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listAreas, createArea, updateArea, type Area } from "../../api/areas";
import ResponsiveTable from "../../components/ResponsiveTable";

/** Участки (раздел про адаптацию под планшет — "администрирование
 * участков, какие есть и т.п.") — раньше жёсткий enum, теперь создаваемая
 * администратором сущность, тот же паттерн, что "Роли и права": название
 * редактируется, код (стабильный идентификатор в базе) выводится сервером
 * из названия и не меняется. Без прав отдельной карточкой — участкам,
 * в отличие от ролей, назначать нечего. */
export default function AreaAdmin() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<{ name: string }>();
  const [renaming, setRenaming] = useState<Area | null>(null);
  const [renameForm] = Form.useForm<{ name: string }>();

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });

  const createMutation = useMutation({
    mutationFn: (name: string) => createArea(name),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["areas"] });
      setCreateOpen(false);
      createForm.resetFields();
      message.success("Участок создан");
    },
    onError: () => message.error("Не удалось создать — название уже занято?"),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ code, is_active }: { code: string; is_active: boolean }) => updateArea(code, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["areas"] });
      message.success("Сохранено");
    },
  });

  const renameMutation = useMutation({
    mutationFn: (name: string) => updateArea(renaming!.code, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["areas"] });
      setRenaming(null);
      message.success("Переименовано");
    },
    onError: () => message.error("Не удалось переименовать — название уже занято?"),
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Участки"
        extra={
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            Добавить участок
          </Button>
        }
      >
        <ResponsiveTable<Area>
          rowKey="code"
          loading={areasQuery.isLoading}
          dataSource={areasQuery.data ?? []}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name" },
            { title: "Код", dataIndex: "code", render: (v: string) => <Typography.Text type="secondary">{v}</Typography.Text> },
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
                      setRenaming(a);
                      renameForm.setFieldsValue({ name: a.name });
                    }}
                  >
                    Переименовать
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
        <Form form={createForm} layout="vertical" onFinish={(v) => createMutation.mutate(v.name)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus placeholder="Раскрой ПВХ" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal title={`Переименовать «${renaming?.name ?? ""}»`} open={!!renaming} onCancel={() => setRenaming(null)} footer={null} destroyOnHidden>
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
