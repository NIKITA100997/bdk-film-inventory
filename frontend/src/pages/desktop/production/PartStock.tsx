import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Space, Typography, Input, Select, Checkbox, Table, Tag, Button } from "antd";
import { useQuery } from "@tanstack/react-query";
import { listPartUnits, type PartUnit } from "../../../api/partUnits";
import { listAreas } from "../../../api/areas";

interface PartStockGroup {
  partId: number;
  partName: string;
  available: number;
  byStage: { stageName: string; qty: number }[];
  byArea: { area: string | null; qty: number }[];
  unplacedCount: number;
}

/** Остатки п/ф (раздел про переработку вкладок остатков/стеллажей) —
 * сводка по детали, зеркалит «Остатки плёнки» (MaterialsExplorer.tsx):
 * там журнал партий (PartUnits.tsx) показывает КАЖДУЮ партию отдельной
 * строкой, здесь — сколько всего доступно по каждой детали, разложено
 * по этапам и участкам, без разглядывания отдельных партий. */
export default function PartStock() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [areaFilter, setAreaFilter] = useState<string | undefined>(undefined);
  const [showEmpty, setShowEmpty] = useState(false);

  const unitsQuery = useQuery({ queryKey: ["part-units"], queryFn: () => listPartUnits() });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "—");
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));

  const groups = useMemo(() => {
    const units = unitsQuery.data ?? [];
    const byPart = new Map<number, PartUnit[]>();
    for (const u of units) {
      if (u.status === "Списан") continue;
      const arr = byPart.get(u.part_id) ?? [];
      arr.push(u);
      byPart.set(u.part_id, arr);
    }
    const result: PartStockGroup[] = [];
    for (const [partId, us] of byPart) {
      const available = us.reduce((sum, u) => sum + u.quantity_available, 0);
      if (available <= 0 && !showEmpty) continue;
      const stageMap = new Map<string, number>();
      const areaMap = new Map<string | null, number>();
      let unplacedCount = 0;
      for (const u of us) {
        if (u.quantity_available <= 0) continue;
        stageMap.set(u.stage_name, (stageMap.get(u.stage_name) ?? 0) + u.quantity_available);
        areaMap.set(u.area, (areaMap.get(u.area) ?? 0) + u.quantity_available);
        if (!u.location_code) unplacedCount += 1;
      }
      result.push({
        partId,
        partName: us[0].part_name,
        available,
        byStage: [...stageMap.entries()].map(([stageName, qty]) => ({ stageName, qty })),
        byArea: [...areaMap.entries()].map(([area, qty]) => ({ area, qty })),
        unplacedCount,
      });
    }
    return result.sort((a, b) => a.partName.localeCompare(b.partName, "ru"));
  }, [unitsQuery.data, showEmpty]);

  const filtered = groups.filter((g) => {
    if (search.trim() && !g.partName.toLowerCase().includes(search.trim().toLowerCase())) return false;
    if (areaFilter && !g.byArea.some((a) => a.area === areaFilter)) return false;
    return true;
  });

  const totalAvailable = filtered.reduce((sum, g) => sum + g.available, 0);

  return (
    <Card title="Остатки п/ф">
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        Сводка «сколько всего доступно» по каждой детали — для отдельных партий и журнала событий см. «Учёт п/ф».
      </Typography.Paragraph>
      <Space wrap size={[12, 12]} style={{ marginBottom: 16, width: "100%" }}>
        <Input.Search
          allowClear
          placeholder="Поиск по детали…"
          style={{ width: 260 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          allowClear
          placeholder="Все участки"
          style={{ width: 220 }}
          options={areaOptions}
          value={areaFilter}
          onChange={setAreaFilter}
        />
        <Checkbox checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)}>
          Показывать без остатка
        </Checkbox>
      </Space>

      <Table<PartStockGroup>
        size="small"
        tableLayout="fixed"
        rowKey="partId"
        loading={unitsQuery.isLoading}
        dataSource={filtered}
        pagination={{ pageSize: 30 }}
        scroll={{ x: "max-content" }}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>
              <Typography.Text strong>Итого позиций: {filtered.length}</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1}>
              <Typography.Text strong>{Math.round(totalAvailable)} шт</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={2} colSpan={3} />
          </Table.Summary.Row>
        )}
        columns={[
          { title: "Деталь", dataIndex: "partName", width: 260, ellipsis: true },
          {
            title: "Доступно, шт",
            width: 110,
            render: (_, g) => <Typography.Text strong>{Math.round(g.available * 100) / 100}</Typography.Text>,
            sorter: (a, b) => a.available - b.available,
          },
          {
            title: "По этапам",
            render: (_, g) => (
              <Space size={4} wrap>
                {g.byStage.map((s) => (
                  <Tag key={s.stageName} style={{ margin: 0 }}>
                    {s.stageName}: {Math.round(s.qty * 100) / 100}
                  </Tag>
                ))}
              </Space>
            ),
          },
          {
            title: "По участкам",
            render: (_, g) => (
              <Space size={4} wrap>
                {g.byArea.map((a) => (
                  <Tag key={a.area ?? "none"} color={a.area ? "blue" : undefined} style={{ margin: 0 }}>
                    {a.area ? areaLabel(a.area) : "склад (не выдано)"}: {Math.round(a.qty * 100) / 100}
                  </Tag>
                ))}
                {g.unplacedCount > 0 && (
                  <Tag color="volcano" style={{ margin: 0 }}>
                    без адреса: {g.unplacedCount}
                  </Tag>
                )}
              </Space>
            ),
          },
          {
            title: "",
            width: 90,
            render: (_, g) => (
              <Button size="small" onClick={() => navigate("/part-units", { state: { partFilter: g.partName } })}>
                Партии →
              </Button>
            ),
          },
        ]}
      />
    </Card>
  );
}
