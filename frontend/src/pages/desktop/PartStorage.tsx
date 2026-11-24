import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { Card, Space, Typography, Button, Modal, Form, Input, InputNumber, Tag, message } from "antd";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createPartRack, getPartRackOccupancy, listPartRacks, placePartUnit, type PartRackOccupancyCell } from "../../api/partStorage";
import { listPartUnits, type PartUnit } from "../../api/partUnits";
import { printPartRackLabel, printPartShelfLabelsBatch, printPartUnitLabelsBatch } from "../../api/partLabels";
import PrintFormatButton from "../../components/PrintFormatButton";
import CollapsibleWarningBanner from "../../components/CollapsibleWarningBanner";
import DecorThumbnail from "../../components/DecorThumbnail";
import { parseBaseAndDecor } from "./Nomenclature";
import { listAreas } from "../../api/areas";
import { useAuth } from "../../auth/AuthContext";
import { apiErrorMessage } from "../../utils/apiError";
import { pfNo } from "../../utils/lotNo";
import { hasPerm } from "../../auth/permissions";

/** Без адреса (раздел про адресное хранение деталей) — зеркалит
 * UnplacedUnitsCard у плёнки (StorageMap.tsx): партии физически на
 * хранении/выданы участку, но без ячейки — зависли посреди регистрации,
 * либо задним числом заведены без места (см. ввод остатков п/ф).
 * Списанные (SPISAN) сюда не попадают — им адрес уже не нужен. Без
 * подсказки места (в отличие от плёнки) — у п/ф пока нет автоподбора
 * ячейки по составу/типу, только ручной ввод, тот же, что и в "Учёт п/ф". */
function UnplacedPartUnitsCard({ areaLabel }: { areaLabel: (code: string | null) => string | null }) {
  const qc = useQueryClient();
  const unitsQuery = useQuery({ queryKey: ["part-units"], queryFn: () => listPartUnits() });
  const unplaced = (unitsQuery.data ?? []).filter((u) => !u.location_code && u.status !== "Списан");
  if (unplaced.length === 0) return null;

  return (
    <div style={{ marginBottom: 16 }}>
      <CollapsibleWarningBanner storageKey="part-unplaced" count={unplaced.length} label="Без адреса">
        <Space orientation="vertical" style={{ width: "100%" }} size={6}>
          {unplaced.map((u) => (
            <UnplacedPartUnitRow key={u.id} unit={u} areaLabel={areaLabel} onPlaced={() => qc.invalidateQueries({ queryKey: ["part-units"] })} />
          ))}
        </Space>
      </CollapsibleWarningBanner>
    </div>
  );
}

function UnplacedPartUnitRow({
  unit,
  areaLabel,
  onPlaced,
}: {
  unit: PartUnit;
  areaLabel: (code: string | null) => string | null;
  onPlaced: () => void;
}) {
  const [locationCode, setLocationCode] = useState("");
  const placeMutation = useMutation({
    mutationFn: (code: string) => placePartUnit(unit.id, code),
    onSuccess: () => {
      message.success("Партия размещена");
      onPlaced();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось разместить")),
  });
  const { baseName, decorLabel } = parseBaseAndDecor(unit.part_name);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <Typography.Text strong>{pfNo(unit.id)}</Typography.Text>
      <Typography.Text>{baseName}</Typography.Text>
      {decorLabel ? (
        <Tag
          color={decorLabel.includes("ПЭТ") ? "purple" : "geekblue"}
          style={{
            margin: 0,
            fontWeight: 600,
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <DecorThumbnail decor={decorLabel} size={14} />
          {decorLabel}
        </Tag>
      ) : (
        <Tag style={{ margin: 0, color: "#8c8c8c" }}>без плёнки</Tag>
      )}
      <Typography.Text type="secondary">{unit.quantity_pieces} шт</Typography.Text>
      <Tag style={{ margin: 0 }}>{unit.stage_name}</Tag>
      {unit.film_restriction && (
        <Tag color="cyan" style={{ margin: 0 }}>
          {unit.film_restriction}
        </Tag>
      )}
      {unit.area && (
        <Tag color="blue" style={{ margin: 0 }}>
          {areaLabel(unit.area)}
        </Tag>
      )}
      <Input
        size="small"
        placeholder="Код ячейки"
        style={{ width: 140 }}
        value={locationCode}
        onChange={(e) => setLocationCode(e.target.value)}
      />
      <Button size="small" type="primary" loading={placeMutation.isPending} disabled={!locationCode.trim()} onClick={() => placeMutation.mutate(locationCode.trim())}>
        Разместить
      </Button>
    </div>
  );
}

/** Стеллажи п/ф (раздел про адресное хранение деталей) — упрощённая
 * параллель StorageMap.tsx: без типа (рулонный/штрипсовый), склада и
 * макрозон/лимитов занятости — п/ф живёт в одном цехе, полка просто
 * адрес (см. BDK_Учет_ПФ_план.md). Размещение партии на полку — действие
 * в PartUnits.tsx («Учёт п/ф»), не здесь: этот экран только показывает
 * схему стеллажей, чтобы найти свободное место или конкретную партию. */
export default function PartStorage() {
  const { user } = useAuth();
  const location = useLocation();
  const canManage = hasPerm(user, "part_storage.manage");
  const qc = useQueryClient();
  const [rackId, setRackId] = useState<number | null>(null);
  const [highlightShelf, setHighlightShelf] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [form] = Form.useForm<{ code: string; shelf_count: number }>();

  // Раздел про сканирование "ЗГ-..." (unitSearch.ts) — предвыбор стеллажа
  // и подсветка полки, тот же приём, что уже есть у StorageMap.tsx.
  useEffect(() => {
    const state = location.state as { rackId?: number; highlightShelf?: number } | null;
    if (state?.rackId) {
      setRackId(state.rackId);
      if (state.highlightShelf) {
        const shelf = state.highlightShelf;
        setHighlightShelf(shelf);
        setTimeout(() => setHighlightShelf((cur) => (cur === shelf ? null : cur)), 5000);
      }
    }
  }, [location.state]);

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : null);

  const racksQuery = useQuery({ queryKey: ["part-racks"], queryFn: () => listPartRacks() });
  const activeRacks = (racksQuery.data ?? []).filter((r) => r.is_active);
  const selectedRack = activeRacks.find((r) => r.id === rackId) ?? activeRacks[0] ?? null;

  const occupancyByRack = useQueries({
    queries: activeRacks.map((r) => ({ queryKey: ["part-rack-occupancy", r.id], queryFn: () => getPartRackOccupancy(r.id) })),
  });
  const occupancyForSelected = occupancyByRack[activeRacks.findIndex((r) => r.id === selectedRack?.id)]?.data;

  const byShelf = useMemo(() => {
    const map = new Map<number, PartRackOccupancyCell>();
    for (const c of occupancyForSelected ?? []) map.set(c.shelf, c);
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [occupancyForSelected]);

  // Поиск партии/детали по всем стеллажам сразу (раздел про удобство
  // мастера/кладовщика — искать нужно не только по QR-скану "ЗГ-...", но
  // и вручную, если под рукой нет сканера или номер партии не при себе).
  const searchNeedle = search.trim().toLowerCase();
  const cellMatchesSearch = (cell: PartRackOccupancyCell) =>
    !!searchNeedle &&
    cell.units.some(
      (u) =>
        String(u.id).includes(searchNeedle) ||
        u.part_name.toLowerCase().includes(searchNeedle) ||
        (searchNeedle === "без плёнки" && !parseBaseAndDecor(u.part_name).decorLabel)
    );
  const rackHasMatch = (idx: number) => !searchNeedle || (occupancyByRack[idx]?.data ?? []).some(cellMatchesSearch);

  // Сводка ходовых декоров на стеллажах для мгновенной подсветки полок в 1 клик/тап
  const popularStorageDecors = useMemo(() => {
    const map = new Map<string, number>();
    for (const q of occupancyByRack) {
      for (const cell of q.data ?? []) {
        for (const u of cell.units) {
          const { decorLabel } = parseBaseAndDecor(u.part_name);
          const label = decorLabel ?? "— без плёнки —";
          map.set(label, (map.get(label) ?? 0) + u.quantity_pieces);
        }
      }
    }
    return [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([decor, qty]) => ({ decor, qty }));
  }, [occupancyByRack]);

  const createMutation = useMutation({
    mutationFn: createPartRack,
    onSuccess: (rack) => {
      qc.invalidateQueries({ queryKey: ["part-racks"] });
      setCreateOpen(false);
      form.resetFields();
      setRackId(rack.id);
      message.success("Стеллаж добавлен");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось добавить стеллаж — код уже занят?")),
  });

  if (!racksQuery.isLoading && activeRacks.length === 0) {
    return (
      <Card>
        <UnplacedPartUnitsCard areaLabel={areaLabel} />
        <Typography.Title level={4}>Стеллажи п/ф</Typography.Title>
        <Typography.Paragraph type="secondary">Стеллажи ещё не заведены.</Typography.Paragraph>
        {canManage && (
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            + Добавить стеллаж
          </Button>
        )}
        {createRackModal()}
      </Card>
    );
  }

  function createRackModal() {
    return (
      <Modal title="Новый стеллаж п/ф" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form form={form} layout="vertical" onFinish={(v) => createMutation.mutate(v)}>
          <Form.Item name="code" label="Код (например, ЗГ-1)" rules={[{ required: true }]}>
            <Input placeholder="ЗГ-1" />
          </Form.Item>
          <Form.Item name="shelf_count" label="Число полок" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>
    );
  }

  return (
    <Card>
      <UnplacedPartUnitsCard areaLabel={areaLabel} />
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }} wrap>
        <Typography.Title level={4} style={{ margin: 0 }}>
          Стеллажи п/ф
        </Typography.Title>
        {canManage && (
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            + Добавить стеллаж
          </Button>
        )}
      </Space>

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginBottom: 16 }}>
        <Input.Search
          allowClear
          placeholder="Поиск по всем стеллажам — № партии, деталь…"
          style={{ width: 320 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {popularStorageDecors.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, overflowX: "auto", maxWidth: "100%", paddingBottom: 4 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
              Подсветить декор:
            </Typography.Text>
            {popularStorageDecors.map((item) => {
              const isBare = item.decor === "— без плёнки —";
              const tagText = isBare ? "без плёнки" : item.decor;
              const isSelected = search.toLowerCase() === tagText.toLowerCase();
              return (
                <Tag.CheckableTag
                  key={item.decor}
                  checked={isSelected}
                  onChange={(checked) => setSearch(checked ? tagText : "")}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                    padding: "3px 10px",
                    borderRadius: 14,
                    fontSize: 12,
                    fontWeight: isSelected ? 700 : 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    border: isSelected ? "1.5px solid #C97A2B" : "1px solid #d9d9d9",
                    background: isSelected ? "#FBF0E3" : "#fff",
                    color: isSelected ? "#A05A17" : "#262626",
                  }}
                >
                  {isBare ? (
                    <span style={{ fontSize: 12 }}>🪵</span>
                  ) : (
                    <DecorThumbnail decor={item.decor} size={14} />
                  )}
                  <span>{isBare ? "Без плёнки" : item.decor}</span>
                  <span style={{ opacity: 0.65, fontSize: 11 }}>({item.qty})</span>
                </Tag.CheckableTag>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 20, alignItems: "start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 720, overflowY: "auto" }}>
          {activeRacks.map((rack, idx) => {
            if (!rackHasMatch(idx)) return null;
            const occ = occupancyByRack[idx]?.data;
            const total = occ?.length ?? rack.shelf_count;
            const used = occ?.filter((c) => c.units.length > 0).length ?? 0;
            const isSelected = selectedRack?.id === rack.id;
            return (
              <Card
                key={rack.id}
                size="small"
                onClick={() => setRackId(rack.id)}
                style={{
                  cursor: "pointer",
                  borderColor: isSelected ? "#C97A2B" : undefined,
                  boxShadow: isSelected ? "0 0 0 2px #FBF0E3" : undefined,
                }}
              >
                <Typography.Text strong>{rack.code}</Typography.Text>
                <div>
                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    {used} из {total} полок занято
                  </Typography.Text>
                </div>
              </Card>
            );
          })}
        </div>

        {selectedRack ? (
          <Card>
            <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 12 }} wrap>
              <Typography.Title level={5} style={{ margin: 0 }}>
                Стеллаж {selectedRack.code} — {selectedRack.shelf_count} полок
              </Typography.Title>
              <Space wrap>
                <PrintFormatButton tip="Печать бирки стеллажа" onPrint={(fmt) => printPartRackLabel(selectedRack.id, { pageFormat: fmt })}>
                  Печать бирки стеллажа
                </PrintFormatButton>
                <PrintFormatButton
                  tip="Печать этикеток полок"
                  onPrint={(fmt) =>
                    printPartShelfLabelsBatch(
                      selectedRack.id,
                      byShelf.map(([shelf, cell]) => ({ shelf, location_code: cell.location_code })),
                      { pageFormat: fmt },
                    )
                  }
                >
                  Печать этикеток полок
                </PrintFormatButton>
              </Space>
            </Space>
            <div style={{ background: "#fff", border: "1px solid #DEDEDA", borderRadius: 10, padding: 14 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {byShelf.map(([shelf, cell]) => {
                  const occupied = cell.units.length > 0;
                  const highlighted = shelf === highlightShelf || cellMatchesSearch(cell);
                  return (
                    <div key={shelf} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <Typography.Text style={{ width: 56, fontSize: 12, textAlign: "right", flexShrink: 0 }} type="secondary">
                        полка {shelf}
                      </Typography.Text>
                      <div
                        style={{
                          flex: "1 1 0%",
                          minWidth: 0,
                          borderRadius: 8,
                          border: `1px solid ${highlighted ? "#C97A2B" : occupied ? "#1D9E75" : "#d9d9d9"}`,
                          boxShadow: highlighted ? "0 0 0 2px #FBF0E3" : undefined,
                          background: occupied ? "#e7f5ee" : "#fafafa",
                          padding: "7px 14px",
                          display: "flex",
                          flexDirection: "column",
                          gap: 4,
                          minHeight: 32,
                        }}
                      >
                        {occupied ? (
                          cell.units.map((u) => {
                            const { baseName, decorLabel } = parseBaseAndDecor(u.part_name);
                            return (
                              <div key={u.id} style={{ display: "flex", flexWrap: "wrap", gap: "2px 8px", alignItems: "center" }}>
                                <Typography.Text strong>{pfNo(u.id)}</Typography.Text>
                                <Typography.Text>{baseName}</Typography.Text>
                                {decorLabel ? (
                                  <Tag
                                    color={decorLabel.includes("ПЭТ") ? "purple" : "geekblue"}
                                    style={{
                                      margin: 0,
                                      fontWeight: 600,
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 4,
                                    }}
                                  >
                                    <DecorThumbnail decor={decorLabel} size={14} />
                                    {decorLabel}
                                  </Tag>
                                ) : (
                                  <Tag style={{ margin: 0, color: "#8c8c8c" }}>без плёнки</Tag>
                                )}
                                <Typography.Text type="secondary">{u.quantity_pieces} шт</Typography.Text>
                                <Tag style={{ margin: 0 }}>{u.stage_name}</Tag>
                                {u.film_restriction && (
                                  <Tag color="cyan" style={{ margin: 0 }}>
                                    {u.film_restriction}
                                  </Tag>
                                )}
                                {/* Раздел про совместимость area+location_code у п/ф — партия на
                                    стеллаже может одновременно числиться выданной участку
                                    (запас, из которого мастер расходует по отчётам), это
                                    нужно видеть прямо на карте, не только в "Учёт п/ф". */}
                                {u.area && (
                                  <Tag color="blue" style={{ margin: 0 }}>
                                    {areaLabel(u.area)}
                                  </Tag>
                                )}
                              </div>
                            );
                          })
                        ) : (
                          <Typography.Text type="secondary">{cell.location_code} — свободно</Typography.Text>
                        )}
                      </div>
                      {occupied && (
                        <PrintFormatButton
                          variant="icon"
                          tip="Печать этикеток партий"
                          onPrint={(fmt) =>
                            printPartUnitLabelsBatch(
                              cell.units.map((u) => u.id),
                              { pageFormat: fmt },
                            )
                          }
                        >
                          🖨
                        </PrintFormatButton>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </Card>
        ) : (
          <Card style={{ textAlign: "center", padding: "24px 8px", color: "#6B6B68" }}>Выберите стеллаж слева.</Card>
        )}
      </div>

      {createRackModal()}
    </Card>
  );
}
