import { useEffect, useMemo, useState } from "react";
import { Alert, Button, InputNumber, Modal, Space, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { listAreas } from "../../../api/areas";
import { createPfTasks, listPfDemand, setPfReservation, suggestLaminationArea, type PfDemandRow } from "../../../api/pfDemand";
import LaminationAreaSelect from "../../../components/LaminationAreaSelect";
import { apiErrorMessage } from "../../../utils/apiError";

const fmt = (n: number) => Math.round(n * 100) / 100;

/** Сколько запустить в производство: нехватка сверх свободного остатка (его
 * можно просто зарезервировать), не меньше минимальной партии. */
function suggestedQty(r: PfDemandRow): number {
  const s = r.sources[0];
  if (!s) return 0;
  const toMake = Math.max(0, s.shortage - r.free);
  return toMake > 0 ? Math.max(toMake, r.min_batch ?? 0) : 0;
}

/** Обеспечение п/ф одного задания цеха (окутка): что нужно по заданию, что
 * свободно на остатке, резерв под задание и задания на производство п/ф
 * «под это задание» — сделанное по ним само уходит в его резерв. */
export default function PfSupplyModal({
  taskId,
  taskName,
  canManage,
  onClose,
}: {
  taskId: number;
  taskName: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["pf-demand", [taskId]], queryFn: () => listPfDemand([taskId]) });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaName = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : null);
  const rows = useMemo(() => query.data ?? [], [query.data]);
  const [reserve, setReserve] = useState<Record<number, number | null>>({});
  const [make, setMake] = useState<Record<number, number | null>>({});
  const [lamArea, setLamArea] = useState<Record<number, string>>({});

  useEffect(() => {
    setReserve(Object.fromEntries(rows.map((r) => [r.part_id, r.sources[0]?.reserve_set || null])));
    setMake(Object.fromEntries(rows.map((r) => [r.part_id, suggestedQty(r) || null])));
  }, [rows]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pf-demand"] });
    qc.invalidateQueries({ queryKey: ["production-tasks"] });
  };

  const reserveMutation = useMutation({
    mutationFn: async (items: { part_id: number; quantity_pieces: number }[]) => {
      for (const it of items) await setPfReservation({ task_id: taskId, ...it });
    },
    onSuccess: () => {
      refresh();
      message.success("Резерв сохранён");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить резерв")),
  });

  const toMake = rows.filter((r) => (make[r.part_id] ?? 0) > 0 && r.first_stage_area);
  const createMutation = useMutation({
    mutationFn: () =>
      createPfTasks({
        for_task_id: taskId,
        items: toMake.map((r) => ({
          part_id: r.part_id,
          quantity_pieces: make[r.part_id] as number,
          lamination_area: lamArea[r.part_id] ?? suggestLaminationArea(r, make[r.part_id]) ?? null,
        })),
      }),
    onSuccess: (res) => {
      refresh();
      message.success(`Создано заданий на п/ф под задание №${taskId}: ${res.task_ids.length}`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать задания")),
  });

  // «Взять со склада»: резерв + свободный остаток, но не больше нехватки.
  const fromFree = rows
    .map((r) => {
      const s = r.sources[0];
      const add = s ? Math.min(r.free, s.shortage) : 0;
      return { part_id: r.part_id, quantity_pieces: fmt((s?.reserve_set ?? 0) + add), add };
    })
    .filter((x) => x.add > 0);

  const changedReserves = rows
    .filter((r) => (reserve[r.part_id] ?? 0) !== (r.sources[0]?.reserve_set ?? 0))
    .map((r) => ({ part_id: r.part_id, quantity_pieces: reserve[r.part_id] ?? 0 }));

  return (
    <Modal
      title={`Обеспечение п/ф — задание №${taskId} «${taskName}»`}
      open
      onCancel={onClose}
      footer={<Button onClick={onClose}>Закрыть</Button>}
      width="95vw"
      style={{ maxWidth: 1300, top: 16 }}
      destroyOnHidden
    >
      <Typography.Paragraph type="secondary">
        Резерв закрепляет штуки остатка за этим заданием: в «Потребности п/ф» другие задания их не считают свободными.
        Резерв не больше того, что осталось сделать по заданию, и снимается сам по мере отчётов окутки. Сделанное по
        заданиям на п/ф «под это задание» уходит в резерв автоматически. Израсходовать зарезервированное другим заданием
        нельзя — такой отчёт не примется, пока резерв не снимут.
      </Typography.Paragraph>
      {!query.isLoading && rows.length === 0 && (
        <Alert
          type="info"
          showIcon
          message="По заданию нет деталей п/ф, учитываемых партиями, или всё уже сделано"
        />
      )}
      {rows.length > 0 && (
        <>
          <Space wrap style={{ marginBottom: 12 }}>
            {canManage && (
              <>
                <Button
                  disabled={fromFree.length === 0}
                  loading={reserveMutation.isPending}
                  onClick={() => reserveMutation.mutate(fromFree.map(({ part_id, quantity_pieces }) => ({ part_id, quantity_pieces })))}
                >
                  Зарезервировать из свободного остатка ({fromFree.length})
                </Button>
                <Button
                  disabled={changedReserves.length === 0}
                  loading={reserveMutation.isPending}
                  onClick={() => reserveMutation.mutate(changedReserves)}
                >
                  Сохранить резерв ({changedReserves.length})
                </Button>
                <Button
                  type="primary"
                  disabled={toMake.length === 0}
                  loading={createMutation.isPending}
                  onClick={() => createMutation.mutate()}
                >
                  Создать задания на п/ф под это задание ({toMake.length})
                </Button>
              </>
            )}
          </Space>
          <ResponsiveTable<PfDemandRow>
            tableKey="pf-supply"
            lockedColumns={["Деталь"]}
            size="small"
            rowKey="part_id"
            loading={query.isLoading}
            dataSource={rows}
            pagination={false}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Деталь", dataIndex: "part_name" },
              { title: "Нужно по заданию", render: (_, r) => fmt(r.sources[0]?.remaining ?? 0) },
              {
                title: "Свободно на остатке",
                render: (_, r) => (
                  <span>
                    {fmt(r.free)}
                    {r.reserved > (r.sources[0]?.reserved ?? 0) && (
                      <Typography.Text type="secondary"> (ещё {fmt(r.reserved - (r.sources[0]?.reserved ?? 0))} в резерве других)</Typography.Text>
                    )}
                  </span>
                ),
              },
              {
                title: "Резерв, шт",
                render: (_, r) => {
                  const s = r.sources[0];
                  return (
                    <Space size={4} direction="vertical">
                      <InputNumber
                        min={0}
                        size="small"
                        style={{ width: 100 }}
                        disabled={!canManage}
                        value={reserve[r.part_id] ?? null}
                        onChange={(v) => setReserve((prev) => ({ ...prev, [r.part_id]: v }))}
                      />
                      {s && s.reserved > 0 && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          обеспечено {fmt(s.reserved)}
                        </Typography.Text>
                      )}
                    </Space>
                  );
                },
              },
              { title: "Делается под задание", render: (_, r) => fmt(r.sources[0]?.in_work ?? 0) },
              {
                title: "Не хватает",
                render: (_, r) => {
                  const short = r.sources[0]?.shortage ?? 0;
                  return short > 0 ? <Tag color="red">{fmt(short)}</Tag> : <Tag color="green">обеспечено</Tag>;
                },
              },
              {
                title: "Запустить в производство, шт",
                render: (_, r) =>
                  r.first_stage_area ? (
                    <InputNumber
                      min={0}
                      size="small"
                      style={{ width: 100 }}
                      disabled={!canManage}
                      value={make[r.part_id] ?? null}
                      onChange={(v) => setMake((prev) => ({ ...prev, [r.part_id]: v }))}
                    />
                  ) : (
                    <Tag color="orange">участок первого этапа не указан</Tag>
                  ),
              },
              {
                title: "Ламинация",
                render: (_, r) => (
                  <LaminationAreaSelect
                    row={r}
                    disabled={!canManage}
                    areaName={areaName}
                    value={lamArea[r.part_id] ?? suggestLaminationArea(r, make[r.part_id])}
                    onChange={(v) => setLamArea((prev) => ({ ...prev, [r.part_id]: v }))}
                  />
                ),
              },
              {
                title: "Первый этап",
                render: (_, r) =>
                  r.first_stage_area ? (
                    <span>
                      {areaName(r.first_stage_area)} · <Typography.Text type="secondary">{r.first_stage_name}</Typography.Text>
                    </span>
                  ) : (
                    "—"
                  ),
              },
            ]}
          />
        </>
      )}
    </Modal>
  );
}
