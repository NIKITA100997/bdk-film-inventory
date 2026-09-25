import { useState } from "react";
import { isAxiosError } from "axios";
import { Button, Empty, Input, Modal, Popconfirm, Space, Tree, TreeSelect, Typography, message } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createItemGroup, deleteItemGroup, groupTree, updateItemGroup, type ItemGroup } from "../../../api/items";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

interface TreeNode {
  key: number;
  title: React.ReactNode;
  children: TreeNode[];
}

/** Группы номенклатуры одного вида — папки, как в 1С: добавить (в корень
 * или внутрь выбранной), переименовать, перенести, удалить пустую. */
export default function GroupsModal({
  open,
  onClose,
  kind,
  kindName,
  groups,
}: {
  open: boolean;
  onClose: () => void;
  kind: string;
  kindName: string;
  groups: ItemGroup[];
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [newName, setNewName] = useState("");
  const [editName, setEditName] = useState("");
  const [editParent, setEditParent] = useState<number | null>(null);
  const current = groups.find((g) => g.id === selected) ?? null;
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["item-groups"] });
    qc.invalidateQueries({ queryKey: ["items"] });
  };

  const createMutation = useMutation({
    mutationFn: () => createItemGroup({ kind_code: kind, parent_id: selected, name: newName.trim() }),
    onSuccess: (g) => {
      invalidate();
      setNewName("");
      message.success(`Группа «${g.name}» добавлена`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось добавить группу")),
  });
  const updateMutation = useMutation({
    mutationFn: () => updateItemGroup(current!.id, { name: editName.trim(), parent_id: editParent, sort_order: current!.sort_order }),
    onSuccess: () => {
      invalidate();
      message.success("Сохранено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить группу")),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteItemGroup(current!.id),
    onSuccess: () => {
      invalidate();
      setSelected(null);
      message.success("Группа удалена");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось удалить группу")),
  });

  const toNodes = (parent: number | null): TreeNode[] =>
    groups
      .filter((g) => g.kind_code === kind && g.parent_id === parent)
      .map((g) => ({
        key: g.id,
        title: (
          <span>
            {g.name} <Typography.Text type="secondary">({g.items})</Typography.Text>
          </span>
        ),
        children: toNodes(g.id),
      }));
  const nodes = toNodes(null);

  return (
    <Modal open={open} onCancel={onClose} footer={null} title={`Группы: ${kindName}`} width={560} destroyOnHidden>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {nodes.length ? (
          <Tree
            treeData={nodes}
            defaultExpandAll
            selectedKeys={selected != null ? [selected] : []}
            onSelect={(keys) => {
              const id = keys.length ? Number(keys[0]) : null;
              setSelected(id);
              const g = groups.find((x) => x.id === id);
              setEditName(g?.name ?? "");
              setEditParent(g?.parent_id ?? null);
            }}
          />
        ) : (
          <Empty description="Групп пока нет" />
        )}
        <Space.Compact style={{ width: "100%" }}>
          <Input
            placeholder={current ? `Новая группа внутри «${current.name}»` : "Новая группа (в корне)"}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onPressEnter={() => newName.trim() && createMutation.mutate()}
          />
          <Button type="primary" disabled={!newName.trim()} loading={createMutation.isPending} onClick={() => createMutation.mutate()}>
            Добавить
          </Button>
        </Space.Compact>
        {current && (
          <Space direction="vertical" style={{ width: "100%" }}>
            <Typography.Text strong>Выбрана: {current.name}</Typography.Text>
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Название" />
            <TreeSelect
              allowClear
              style={{ width: "100%" }}
              placeholder="Внутри группы (пусто — в корне)"
              value={editParent ?? undefined}
              onChange={(v) => setEditParent(v ?? null)}
              treeData={groupTree(groups, kind)}
              treeDefaultExpandAll
            />
            <Space>
              <Button disabled={!editName.trim()} loading={updateMutation.isPending} onClick={() => updateMutation.mutate()}>
                Сохранить
              </Button>
              <Popconfirm title={`Удалить группу «${current.name}»?`} description="Только пустую — без позиций и подгрупп." okText="Удалить" cancelText="Отмена" onConfirm={() => deleteMutation.mutate()}>
                <Button danger>Удалить</Button>
              </Popconfirm>
              <Button type="link" onClick={() => setSelected(null)}>
                Снять выбор
              </Button>
            </Space>
          </Space>
        )}
      </Space>
    </Modal>
  );
}
