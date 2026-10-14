import { useMemo, useState } from "react";
import { Button, Empty, Input, List, Space, Tag, Typography } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listPartUnits, type PartUnit } from "../api/partUnits";
import LotOperationModal from "./lotOps/LotOperationModal";
import { lotFromPartUnit } from "./lotOps/lotOps";

/** Выдача п/ф на участок (14.10): партии «На хранении» — «Выдать» отдаёт
 * партию (или её часть) на участок её этапа тем же окном, что в «Остатках». */
export default function PfIssueList() {
  const [q, setQ] = useState("");
  const [lot, setLot] = useState<PartUnit | null>(null);
  const units = useQuery({ queryKey: ["part-units", "stored"], queryFn: () => listPartUnits({ status_: "На_хранении" }) });
  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (units.data ?? [])
        .filter((u) => u.quantity_available > 0)
        .filter((u) => !needle || `${u.part_name} ${u.stage_name} ${u.location_code ?? ""} пф${u.id} ${u.id}`.toLowerCase().includes(needle))
        .sort((a, b) => a.part_name.localeCompare(b.part_name, "ru") || a.manufactured_at.localeCompare(b.manufactured_at)),
    [units.data, needle],
  );
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Input.Search size="large" allowClear placeholder="Деталь, этап, ячейка или № партии" value={q} onChange={(e) => setQ(e.target.value)} />
      <Typography.Text type="secondary">
        Партии на хранении. Старые — выше: выдавайте их первыми. Часть партии — укажите количество в окне выдачи.
      </Typography.Text>
      {!units.isLoading && !rows.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={needle ? "Ничего не найдено" : "На хранении партий нет"} />
      ) : (
        <List
          loading={units.isLoading}
          dataSource={rows}
          pagination={rows.length > 30 ? { pageSize: 30, size: "small" } : false}
          renderItem={(u) => (
            <List.Item
              actions={[
                <Button key="issue" type="primary" onClick={() => setLot(u)}>
                  Выдать
                </Button>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space size={6} wrap>
                    <span>{u.part_name}</span>
                    <Tag>ПФ{u.id}</Tag>
                    {u.film_restriction && <Tag color="purple">{u.film_restriction}</Tag>}
                  </Space>
                }
                description={`${u.quantity_available} шт · этап «${u.stage_name}»${u.location_code ? ` · ячейка ${u.location_code}` : ""} · изготовлена ${u.manufactured_at.slice(8, 10)}.${u.manufactured_at.slice(5, 7)}`}
              />
            </List.Item>
          )}
        />
      )}
      {lot && <LotOperationModal lot={lotFromPartUnit(lot)} op="issue" onClose={() => setLot(null)} onDone={() => setLot(null)} />}
    </Space>
  );
}
