import { useState } from "react";
import { Button, Empty, Modal, Popconfirm, Select, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isAxiosError } from "axios";
import ResponsiveTable from "../../../components/ResponsiveTable";
import {
  listAllParts,
  listPartDuplicates,
  updatePart,
  updatePartsStagesBulk,
  type DuplicateCandidate,
} from "../../../api/dictionaries";
import { listAreas } from "../../../api/areas";

type StageRow = { code: string; name: string; area: string | null };
type AreaOption = { value: string; label: string };

/** Маршрут для нескольких деталей сразу (бывшая «Настроить этапы для
 * выбранных» на вкладке «Детали п/ф»): полностью заменяет этапы, одной
 * транзакцией на сервере — всё или ничего. partIds — детали выбранных позиций. */
export function BulkStagesModal({ partIds, onClose }: { partIds: number[]; onClose: (done: boolean) => void }) {
  const qc = useQueryClient();
  const partsQuery = useQuery({ queryKey: ["parts", "all"], queryFn: listAllParts });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const parts = (partsQuery.data ?? []).filter((p) => partIds.includes(p.id));
  const template = parts.find((p) => p.stages.length > 0);
  const [rows, setRows] = useState<StageRow[] | null>(null);
  const current = rows ?? (template ? template.stages.map((s) => ({ code: s.code, name: s.name, area: s.area })) : []);
  const mutation = useMutation({
    mutationFn: () => updatePartsStagesBulk(partIds, current),
    onSuccess: (res) => {
      for (const k of [["parts"], ["items"], ["techcard"]]) qc.invalidateQueries({ queryKey: k });
      message.success(`Этапы применены: ${res.updated}`);
      onClose(true);
    },
    onError: (e) =>
      message.error(isAxiosError(e) && typeof e.response?.data?.detail === "string" ? e.response.data.detail : "Не удалось сохранить этапы"),
  });
  return (
    <Modal open width={560} title={`Этапы для выбранных деталей: ${partIds.length}`} onCancel={() => onClose(false)} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Применится ко всем отмеченным деталям разом, полностью заменив их этапы. Этап — это участок, порядок сверху вниз.
      </Typography.Paragraph>
      <Space size={[4, 4]} wrap style={{ marginBottom: 12 }}>
        {parts.map((p) => (
          <Tag key={p.id}>{p.name}</Tag>
        ))}
      </Space>
      <StageRowsEditor rows={current} setRows={(f) => setRows(typeof f === "function" ? f(current) : f)} areaOptions={areaOptions} />
      <Button
        type="primary"
        block
        style={{ marginTop: 12 }}
        loading={mutation.isPending}
        disabled={partIds.length === 0}
        onClick={() => {
          if (current.some((r) => !r.area)) {
            message.warning("У каждого этапа должен быть выбран участок");
            return;
          }
          mutation.mutate();
        }}
      >
        Применить к {partIds.length}
      </Button>
    </Modal>
  );
}

function StageRowsEditor({
  rows,
  setRows,
  areaOptions,
}: {
  rows: StageRow[];
  setRows: (f: StageRow[] | ((r: StageRow[]) => StageRow[])) => void;
  areaOptions: AreaOption[];
}) {
  const move = (i: number, d: number) =>
    setRows((rs) => {
      const next = [...rs];
      const t = i + d;
      if (t < 0 || t >= next.length) return rs;
      [next[i], next[t]] = [next[t], next[i]];
      return next;
    });
  const setArea = (i: number, area: string | null) =>
    setRows((rs) =>
      rs.map((r, j) => (j === i ? { code: area ?? "", name: areaOptions.find((a) => a.value === area)?.label ?? "", area } : r)),
    );
  return (
    <Space direction="vertical" style={{ width: "100%" }} size="middle">
      {rows.map((row, i) => (
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
            onChange={(v) => setArea(i, v)}
            optionFilterProp="label"
          />
          <Button size="small" disabled={i === 0} onClick={() => move(i, -1)}>
            ↑
          </Button>
          <Button size="small" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
            ↓
          </Button>
          <Button size="small" danger onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
            Убрать
          </Button>
        </Space>
      ))}
      <Button block onClick={() => setRows((rs) => [...rs, { code: "", name: "", area: null }])}>
        + Добавить этап
      </Button>
    </Space>
  );
}

/** Возможные дубликаты деталей (похожие названия) — архивировать лишнюю. */
export function PartDuplicatesModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["parts", "duplicates"], queryFn: listPartDuplicates });
  const archive = useMutation({
    mutationFn: (id: number) => updatePart(id, { is_active: false }),
    onSuccess: () => {
      for (const k of [["parts"], ["items"]]) qc.invalidateQueries({ queryKey: k });
      message.success("Деталь в архиве");
    },
  });
  return (
    <Modal open width={760} title="Возможные дубликаты деталей" onCancel={onClose} footer={null} destroyOnHidden>
      {!query.isLoading && (query.data ?? []).length === 0 ? (
        <Empty description="Похожих названий не найдено" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <ResponsiveTable<DuplicateCandidate>
          rowKey={(d) => `${d.a_id}-${d.b_id}`}
          size="small"
          loading={query.isLoading}
          pagination={false}
          dataSource={query.data}
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
                  description="Останется для старых записей, но пропадёт из подсказок."
                  onConfirm={() => archive.mutate(d.b_id)}
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
    </Modal>
  );
}
