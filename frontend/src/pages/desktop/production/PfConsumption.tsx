import { useState } from "react";
import { Button, Input, InputNumber, Segmented, Space, Switch, Tag, Tooltip, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { applyReserveDays, getPfConsumption, setReserveDays, type ConsumptionRow } from "../../../api/pfDemand";
import { useAuth } from "../../../auth/AuthContext";
import { hasPerm } from "../../../auth/permissions";
import { apiErrorMessage } from "../../../utils/apiError";

const n = (v: number | null | undefined) => (v == null ? "—" : (Math.round(v * 10) / 10).toLocaleString("ru-RU"));

/** Средний расход п/ф и мин. остаток (14.10): сколько детали уходит в
 * неделю и в рабочий день за выбранный период; дни запаса — вручную,
 * мин. остаток = расход в день × дни запаса. Мин. остаток сам не
 * меняется — только при вводе дней или кнопкой «Пересчитать». */
export default function PfConsumption() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEdit = hasPerm(user, "production_tasks.manage", "part_units.manage");
  const [weeks, setWeeks] = useState(4);
  const [q, setQ] = useState("");
  const [onlyUsed, setOnlyUsed] = useState(true);
  const query = useQuery({ queryKey: ["pf-consumption", weeks], queryFn: () => getPfConsumption(weeks) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["pf-consumption"] });
    qc.invalidateQueries({ queryKey: ["pf-demand"] });
  };
  const save = useMutation({
    mutationFn: (p: { item_id: number; reserve_days: number | null }) => setReserveDays({ ...p, weeks }),
    onSuccess: (r) => {
      refresh();
      if (r) message.success(r.suggested_min != null ? `«${r.name}»: мин. остаток ${n(r.suggested_min)} шт` : `«${r.name}»: дни запаса сняты`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  const applyAll = useMutation({
    mutationFn: () => applyReserveDays(weeks),
    onSuccess: (r) => {
      refresh();
      message.success(r.changed ? `Мин. остатки пересчитаны: ${r.changed}` : "Всё уже по расходу");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось пересчитать")),
  });
  const data = query.data;
  const needle = q.trim().toLowerCase();
  const rows = (data?.rows ?? []).filter((r) => (!onlyUsed || r.consumed > 0 || r.reserve_days != null) && (!needle || r.name.toLowerCase().includes(needle)));
  const outdated = (data?.rows ?? []).filter((r) => r.reserve_days != null && r.suggested_min !== r.min_stock).length;

  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        Расход — всё, что списано с остатка за период: в работу по заданиям, брак и пусковые. В день — на рабочий день по календарю
        производства. Дни запаса задаёте вы; мин. остаток = расход в день × дни запаса, он сразу идёт в потребность п/ф. Сам мин.
        остаток не меняется — пересчитайте кнопкой, когда расход изменится.
      </Typography.Paragraph>
      <Space wrap>
        <Segmented
          value={weeks}
          onChange={(v) => setWeeks(v as number)}
          options={[
            { value: 2, label: "2 нед." },
            { value: 4, label: "4 нед." },
            { value: 8, label: "8 нед." },
            { value: 12, label: "12 нед." },
          ]}
        />
        {data && (
          <Typography.Text type="secondary">
            {dayjs(data.date_from).format("DD.MM")}–{dayjs(data.date_to).subtract(1, "day").format("DD.MM")}, рабочих дней {data.workdays}
          </Typography.Text>
        )}
        <Input.Search allowClear placeholder="Деталь" style={{ width: 240 }} value={q} onChange={(e) => setQ(e.target.value)} />
        <Space size={6}>
          <Switch size="small" checked={onlyUsed} onChange={setOnlyUsed} />
          <Typography.Text>только с расходом или днями запаса</Typography.Text>
        </Space>
        {canEdit && (
          <Button disabled={!outdated} loading={applyAll.isPending} onClick={() => applyAll.mutate()}>
            Пересчитать мин. остатки по расходу ({outdated})
          </Button>
        )}
      </Space>
      <ResponsiveTable<ConsumptionRow>
        tableKey="pf-consumption"
        lockedColumns={["Деталь"]}
        size="small"
        rowKey="item_id"
        loading={query.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 50 }}
        scroll={{ x: "max-content" }}
        locale={{ emptyText: "Расхода за период нет" }}
        columns={[
          { title: "Деталь", dataIndex: "name" },
          {
            title: "Расход за период, шт",
            align: "right",
            sorter: (a, b) => a.consumed - b.consumed,
            render: (_, r) => (
              <Tooltip title={`в работу по заданиям ${n(r.to_work)}, брак и пусковые ${n(r.consumed - r.to_work)}`}>
                {n(r.consumed)}
              </Tooltip>
            ),
          },
          { title: "В неделю", align: "right", sorter: (a, b) => a.per_week - b.per_week, render: (_, r) => n(r.per_week) },
          { title: "В день", align: "right", render: (_, r) => n(r.per_day) },
          {
            title: "Дней запаса",
            render: (_, r) =>
              canEdit ? (
                <InputNumber
                  key={`${r.item_id}-${r.reserve_days}`}
                  size="small"
                  min={0}
                  max={365}
                  style={{ width: 90 }}
                  placeholder="—"
                  defaultValue={r.reserve_days ?? undefined}
                  onBlur={(e) => {
                    const raw = e.target.value.trim().replace(",", ".");
                    const v = raw === "" ? null : Number(raw);
                    if (v === r.reserve_days || (v != null && Number.isNaN(v))) return;
                    save.mutate({ item_id: r.item_id, reserve_days: v });
                  }}
                  onPressEnter={(e) => (e.target as HTMLInputElement).blur()}
                />
              ) : (
                n(r.reserve_days)
              ),
          },
          { title: "Мин. остаток сейчас", align: "right", render: (_, r) => n(r.min_stock) },
          {
            title: "По расходу",
            align: "right",
            render: (_, r) =>
              r.suggested_min == null ? (
                "—"
              ) : r.suggested_min === r.min_stock ? (
                n(r.suggested_min)
              ) : (
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                  {n(r.suggested_min)}
                </Tag>
              ),
          },
        ]}
      />
    </Space>
  );
}
