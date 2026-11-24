import RegistrationStageField from "../../../components/RegistrationStageSelect";
import FilmRestrictionPicker from "../../../components/FilmRestrictionPicker";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Space, Typography, Input, Select, Segmented, Checkbox, Table, Tag, Button, Modal, Form, InputNumber, DatePicker, Dropdown, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dayjs } from "dayjs";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { createPartUnit, listPartUnits, type PartUnit } from "../../../api/partUnits";
import { listAreas } from "../../../api/areas";
import { exportToExcel } from "../../../utils/excel";
import { useAuth } from "../../../auth/AuthContext";
import PartSelect from "../../../components/PartSelect";
import { listParts, type Part } from "../../../api/dictionaries";
import PfReserveCell from "../../../components/PfReserveCell";
import { usePfReserves } from "../../../components/usePfReserves";
import { PfFilterBar, PfSections } from "../../../components/PfGrouping";
import { filterPf, sectionsPf, usePfFilter, usePfIndex } from "../../../components/pfGroupingState";
import { FileExcelOutlined } from "@ant-design/icons";
import { hasPerm } from "../../../auth/permissions";
import PartWriteOffModal from "../../../components/PartWriteOffModal";
import { parseBaseAndDecor } from "../Nomenclature";

export function isStoevayaMk(name?: string | null): boolean {
  if (!name) return false;
  const lower = name.toLowerCase().trim();
  if (lower.includes("панел") || lower.includes("клин")) return false;
  return lower.startsWith("стоевая") || lower.includes("стоевая мк");
}

export interface DecorStock {
  partId: number;
  partName: string;
  decorLabel: string;
  available: number;
  petAvailable: number;
}

export interface PartStockGroup {
  partId: number;
  partName: string;
  baseName: string;
  available: number;
  petAvailable: number;
  byStage: { stageName: string; qty: number }[];
  byArea: { area: string | null; qty: number }[];
  unplacedCount: number;
  decors: DecorStock[];
}

/** Остатки п/ф (раздел про переработку вкладок остатков/стеллажей) —
 * сводка по детали, зеркалит «Остатки плёнки» (MaterialsExplorer.tsx):
 * там журнал партий (PartUnits.tsx) показывает КАЖДУЮ партию отдельной
 * строкой, здесь — сколько всего доступно по каждой детали, разложено
 * по этапам и участкам, без разглядывания отдельных партий. */
export default function PartStock() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const canManage = hasPerm(user, "part_units.manage");
  // Раздел про "в остатки и стеллажи нужно добавить возможность ставить
  // на учёт новые партии" — раньше единственный вход в регистрацию был
  // через "Учёт п/ф", а деталь без единой партии вообще не попадала в
  // этот список (группировка строится ИЗ существующих партий) — то есть
  // для новой детали здесь просто негде было нажать "добавить". Модалка
  // ниже не завязана на конкретную строку — свой выбор детали, как в
  // форме "Учёт п/ф".
  const [registerOpen, setRegisterOpen] = useState(false);
  const [writeOff, setWriteOff] = useState<{ id: number; name: string } | null>(null);
  const canCount = hasPerm(user, "part_units.count");
  const [search, setSearch] = useState("");
  // Раздел про удобство работы мастера участка п/ф — у аккаунта с
  // закреплённым участком (см. isUchastka в MaterialsExplorer.tsx, тот же
  // приём) экран по умолчанию открывается уже отфильтрованным на "что у
  // меня", а не пустым "выберите участок" каждый раз заново.
  const [areaFilter, setAreaFilter] = useState<string | undefined>(user?.area ?? undefined);
  const [showEmpty, setShowEmpty] = useState(false);
  // Раздел про "отдельно посмотреть, что просто на хранении" — раньше
  // сводка складывала На_хранении и Выдан_участку в одно число: с тех пор
  // как area у "на хранении" тоже привязывается к участку этапа (см.
  // mint_part_unit), это стало неотличимо в разбивке "по участкам" —
  // число на тэге участка больше не говорит, сколько из него реально
  // выдано, а сколько просто лежит. Явный фильтр по статусу — тот же
  // переключатель, что уже есть в карточке детали (PartCard.tsx).
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [groupByProfile, setGroupByProfile] = useState(true);
  const [decorFilter, setDecorFilter] = useState<string | undefined>(undefined);
  // Направление / группа / стадия из номенклатуры и разбивка по группам.
  const [pf, setPf] = usePfFilter();
  const { byPart: pfAttrs, groups: itemGroups } = usePfIndex();

  const unitsQuery = useQuery({ queryKey: ["part-units"], queryFn: () => listPartUnits() });
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const reserves = usePfReserves();
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string | null) => (code ? (areasQuery.data?.find((a) => a.code === code)?.name ?? code) : "—");
  const areaOptions = useMemo(
    () =>
      (areasQuery.data ?? [])
        .filter((a) => a.is_active)
        .map((a) => ({
          value: a.code,
          label: a.code === "skleyka_mdf_s_zagotovkoy" ? `${a.name} (склад + участок)` : a.name,
        })),
    [areasQuery.data],
  );

  const myParts = useMemo(
    () =>
      new Set(
        ((partsQuery.data as Part[] | undefined) ?? [])
          .filter((p: Part) => p.stages.some((st) => st.area === areaFilter))
          .map((p: Part) => p.id),
      ),
    [partsQuery.data, areaFilter],
  );

  const groups = useMemo(() => {
    const units = unitsQuery.data ?? [];
    const byPart = new Map<number, PartUnit[]>();
    for (const u of units) {
      if (u.status === "Списан") continue;
      if (statusFilter && u.status !== statusFilter) continue;
      const arr = byPart.get(u.part_id) ?? [];
      arr.push(u);
      byPart.set(u.part_id, arr);
    }

    interface SinglePartStats {
      partId: number;
      partName: string;
      baseName: string;
      decorLabel: string;
      available: number;
      petAvailable: number;
      stageMap: Map<string, number>;
      areaMap: Map<string | null, number>;
      unplacedCount: number;
    }
    const partStatsList: SinglePartStats[] = [];

    for (const [partId, us] of byPart) {
      const available = us.reduce((sum, u) => sum + u.quantity_available, 0);
      const petAvailable = us.filter((u) => u.film_restriction === "pet" && isStoevayaMk(u.part_name)).reduce((sum, u) => sum + u.quantity_available, 0);
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
      const rawName = us[0].part_name;
      const { baseName, decorLabel } = parseBaseAndDecor(rawName);
      partStatsList.push({
        partId,
        partName: rawName,
        baseName,
        decorLabel: decorLabel ?? "— без плёнки —",
        available,
        petAvailable,
        stageMap,
        areaMap,
        unplacedCount,
      });
    }

    if (!groupByProfile) {
      return partStatsList
        .map((p) => ({
          partId: p.partId,
          partName: p.partName,
          baseName: p.baseName,
          available: p.available,
          petAvailable: p.petAvailable,
          byStage: [...p.stageMap.entries()].map(([stageName, qty]) => ({ stageName, qty })),
          byArea: [...p.areaMap.entries()].map(([area, qty]) => ({ area, qty })),
          unplacedCount: p.unplacedCount,
          decors: [
            {
              partId: p.partId,
              partName: p.partName,
              decorLabel: p.decorLabel,
              available: p.available,
              petAvailable: p.petAvailable,
            },
          ],
        }))
        .sort((a, b) => a.partName.localeCompare(b.partName, "ru"));
    }

    const clusterMap = new Map<string, SinglePartStats[]>();
    for (const p of partStatsList) {
      const key = p.baseName.trim().toLowerCase().replace(/ё/g, "е");
      const arr = clusterMap.get(key) ?? [];
      arr.push(p);
      clusterMap.set(key, arr);
    }

    const result: PartStockGroup[] = [];
    for (const cluster of clusterMap.values()) {
      const barePart = cluster.find((p) => p.decorLabel === "— без плёнки —") ?? cluster[0];
      const totalAvailable = cluster.reduce((sum, p) => sum + p.available, 0);
      const totalPet = cluster.reduce((sum, p) => sum + p.petAvailable, 0);
      const totalUnplaced = cluster.reduce((sum, p) => sum + p.unplacedCount, 0);

      const combinedStageMap = new Map<string, number>();
      const combinedAreaMap = new Map<string | null, number>();
      for (const p of cluster) {
        for (const [st, q] of p.stageMap) combinedStageMap.set(st, (combinedStageMap.get(st) ?? 0) + q);
        for (const [ar, q] of p.areaMap) combinedAreaMap.set(ar, (combinedAreaMap.get(ar) ?? 0) + q);
      }

      const decors: DecorStock[] = cluster.map((p) => ({
        partId: p.partId,
        partName: p.partName,
        decorLabel: p.decorLabel,
        available: p.available,
        petAvailable: p.petAvailable,
      }));

      result.push({
        partId: barePart.partId,
        partName: barePart.baseName,
        baseName: barePart.baseName,
        available: totalAvailable,
        petAvailable: totalPet,
        byStage: [...combinedStageMap.entries()].map(([stageName, qty]) => ({ stageName, qty })),
        byArea: [...combinedAreaMap.entries()].map(([area, qty]) => ({ area, qty })),
        unplacedCount: totalUnplaced,
        decors,
      });
    }

    return result.sort((a, b) => a.baseName.localeCompare(b.baseName, "ru"));
  }, [unitsQuery.data, showEmpty, statusFilter, groupByProfile]);

  const decorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const g of groups) {
      for (const d of g.decors) {
        if (d.decorLabel && d.decorLabel !== "— без плёнки —") {
          set.add(d.decorLabel);
        }
      }
    }
    return [...set].sort().map((d) => ({ value: d, label: d }));
  }, [groups]);

  const filtered = filterPf(
    groups.filter((g) => {
      const needle = search.trim().toLowerCase();
      if (
        needle &&
        !g.partName.toLowerCase().includes(needle) &&
        !g.decors.some((d) => d.decorLabel.toLowerCase().includes(needle))
      ) {
        return false;
      }
      if (decorFilter && !g.decors.some((d) => d.decorLabel === decorFilter)) {
        return false;
      }
      if (areaFilter) {
        if (areaFilter === "skleyka_mdf_s_zagotovkoy") {
          // Участок производства полуфабрикатов: объединяем склад и участок,
          // включая партии на участке, на центральном складе ПФ (area === null)
          // и детали, чьи этапы относятся к участку ПФ
          const matches =
            g.byArea.some((a) => a.area === areaFilter || a.area === null) ||
            myParts.has(g.partId);
          if (!matches) return false;
        } else if (!g.byArea.some((a) => a.area === areaFilter)) {
          return false;
        }
      }
      return true;
    }),
    (g) => g.partId,
    pf,
    pfAttrs,
    itemGroups,
  );
  const sections = sectionsPf(filtered, (g) => g.partId, pf, pfAttrs, itemGroups);

  const totalAvailable = filtered.reduce((sum, g) => sum + g.available, 0);

  const exportRows = () =>
    exportToExcel(
      "ostatki-pf.xlsx",
      filtered.map((g) => ({
        part: g.baseName,
        decors: g.decors.length > 1 ? g.decors.map((d) => `${d.decorLabel}: ${Math.round(d.available * 100) / 100}`).join("; ") : (g.decors[0]?.decorLabel !== "— без плёнки —" ? g.decors[0]?.decorLabel : "—"),
        available: Math.round(g.available * 100) / 100,
        stages: g.byStage.map((s) => `${s.stageName}: ${Math.round(s.qty * 100) / 100}`).join(", "),
        areas: g.byArea.map((a) => `${a.area ? areaLabel(a.area) : "склад"}: ${Math.round(a.qty * 100) / 100}`).join(", "),
        unplaced: g.unplacedCount,
        reserved: reserves.get(g.partId)?.reserved ?? 0,
        free: reserves.get(g.partId)?.free ?? Math.round(g.available * 100) / 100,
      })),
      [
        { key: "part", header: "Деталь / Профиль" },
        { key: "decors", header: "В разрезе декоров" },
        { key: "available", header: "Доступно, шт" },
        { key: "stages", header: "По этапам" },
        { key: "areas", header: "По участкам" },
        { key: "unplaced", header: "Без адреса" },
        { key: "reserved", header: "В резерве, шт" },
        { key: "free", header: "Свободно, шт" },
      ],
    );

  return (
    <Card
      title="Остатки п/ф"
      extra={
        <Space size={8} wrap>
          {canManage && (
            <Button size="middle" type="primary" onClick={() => setRegisterOpen(true)} style={{ minHeight: 38 }}>
              + Оприходовать партию
            </Button>
          )}
          {canCount && (
            <Button size="middle" onClick={() => navigate("/inventory")} style={{ minHeight: 38 }}>
              Инвентаризация п/ф
            </Button>
          )}
          <Button icon={<FileExcelOutlined />} size="middle" onClick={exportRows} style={{ minHeight: 38 }}>
            Excel
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
        Сводка «сколько всего доступно» по каждой детали — отдельные партии и все действия с ними на вкладке «Партии».
      </Typography.Paragraph>
      <Space wrap size={[12, 12]} style={{ marginBottom: 16, width: "100%" }}>
        <Input.Search
          allowClear
          placeholder="Поиск по детали или декору…"
          style={{ width: 260 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          allowClear
          placeholder="Все участки"
          style={{ width: 200 }}
          options={areaOptions}
          value={areaFilter}
          onChange={setAreaFilter}
        />
        {decorOptions.length > 0 && (
          <Select
            allowClear
            showSearch
            placeholder="Все декоры / цвета"
            style={{ width: 200 }}
            options={decorOptions}
            value={decorFilter}
            onChange={setDecorFilter}
          />
        )}
        <div style={{ maxWidth: "100%", overflowX: "auto" }}>
        <Segmented
          value={statusFilter ?? "all"}
          onChange={(v) => setStatusFilter(v === "all" ? undefined : (v as string))}
          options={[
            { label: "Всё (кроме списанного)", value: "all" },
            { label: "На хранении", value: "На_хранении" },
            { label: "Выдан участку", value: "Выдан_участку" },
            { label: "В переработку", value: "В_переработку" },
          ]}
        />
        </div>
        <Checkbox checked={groupByProfile} onChange={(e) => setGroupByProfile(e.target.checked)}>
          Группировать по профилям
        </Checkbox>
        <Checkbox checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)}>
          Показывать без остатка
        </Checkbox>
        <PfFilterBar value={pf} onChange={setPf} groups={itemGroups} />
      </Space>

      <PfSections
        sections={sections}
        total={(rows) => `${Math.round(rows.reduce((s, g) => s + g.available, 0))} шт`}
        render={(rows, key) => (
      <ResponsiveTable<PartStockGroup>
        key={key}
        tableKey="part-stock"
        lockedColumns={["Деталь / Профиль"]}
        size="small"
        tableLayout="fixed"
        rowKey="partId"
        loading={unitsQuery.isLoading}
        dataSource={rows}
        pagination={{ pageSize: 30, hideOnSinglePage: true }}
        scroll={{ x: "max-content" }}
        onRow={(g) => ({ onClick: () => navigate("/part-card", { state: { partId: g.partId } }), style: { cursor: "pointer" } })}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>
              <Typography.Text strong>Итого позиций: {rows.length}</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1}>
              <Typography.Text strong>{Math.round(rows.reduce((s, g) => s + g.available, 0))} шт</Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={2} colSpan={4} />
          </Table.Summary.Row>
        )}
        columns={[
          {
            title: "Деталь / Профиль",
            dataIndex: "partName",
            width: 320,
            render: (_, g) => (
              <Space direction="vertical" size={4} style={{ width: "100%" }}>
                <Typography.Text strong style={{ fontSize: 14 }}>
                  {g.baseName}
                </Typography.Text>
                {g.decors.length > 1 && (
                  <Space size={[4, 4]} wrap>
                    {g.decors.map((d) => {
                      const isBare = d.decorLabel === "— без плёнки —";
                      const isHighlighted = decorFilter && d.decorLabel === decorFilter;
                      return (
                        <Tag
                          key={d.partId}
                          color={isHighlighted ? "gold" : isBare ? "default" : "blue"}
                          style={{
                            cursor: "pointer",
                            fontSize: 11,
                            marginRight: 0,
                            fontWeight: isHighlighted || isBare ? 600 : 500,
                            border: isHighlighted ? "1px solid #d4b106" : undefined,
                          }}
                          title={`Деталь #${d.partId}: клик — открыть карточку`}
                          onClick={(e) => {
                            e.stopPropagation();
                            navigate("/part-card", { state: { partId: d.partId } });
                          }}
                        >
                          {d.decorLabel}: <b>{Math.round(d.available * 100) / 100}</b>
                        </Tag>
                      );
                    })}
                  </Space>
                )}
                {g.decors.length === 1 && g.decors[0].decorLabel !== "— без плёнки —" && (
                  <Tag color="blue" style={{ fontSize: 11, width: "fit-content" }}>
                    {g.decors[0].decorLabel}
                  </Tag>
                )}
              </Space>
            ),
          },
          {
            title: "Доступно, шт",
            width: 120,
            render: (_, g) => (
              <div>
                <Typography.Text strong>{Math.round(g.available * 100) / 100}</Typography.Text>
                {g.petAvailable > 0 && (
                  <div style={{ fontSize: 11, color: "#722ed1", fontWeight: 600 }}>
                    ПЭТ: {Math.round(g.petAvailable * 100) / 100}
                  </div>
                )}
              </div>
            ),
            sorter: (a, b) => a.available - b.available,
          },
          {
            title: "Резерв под задания",
            width: 230,
            render: (_, g) => <PfReserveCell reserve={reserves.get(g.partId)} />,
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
                  <Tag
                    key={a.area ?? "none"}
                    color={a.area && a.area === areaFilter ? "green" : a.area ? "blue" : undefined}
                    style={{ margin: 0, fontWeight: a.area === areaFilter ? 700 : undefined }}
                  >
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
          ...(canManage
            ? [
                {
                  title: "",
                  width: 100,
                  render: (_: unknown, g: PartStockGroup) => {
                    if (g.decors.length <= 1) {
                      return (
                        <Button
                          size="middle"
                          danger
                          type="text"
                          style={{ minHeight: 36, paddingInline: 8 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            const target = g.decors[0] ?? g;
                            setWriteOff({ id: target.partId, name: target.partName });
                          }}
                        >
                          Списать
                        </Button>
                      );
                    }
                    return (
                      <Dropdown
                        menu={{
                          items: g.decors.map((d) => ({
                            key: String(d.partId),
                            label: `${d.decorLabel} (${Math.round(d.available * 100) / 100} шт)`,
                            onClick: () => setWriteOff({ id: d.partId, name: d.partName }),
                          })),
                        }}
                      >
                        <Button
                          size="middle"
                          danger
                          type="text"
                          style={{ minHeight: 36, paddingInline: 8 }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          Списать ▾
                        </Button>
                      </Dropdown>
                    );
                  },
                },
              ]
            : []),
        ]}
      />
        )}
      />
      {sections.length > 1 && (
        <Typography.Text strong style={{ display: "block", marginTop: 12 }}>
          Всего: {filtered.length} поз., {Math.round(totalAvailable)} шт
        </Typography.Text>
      )}

      {registerOpen && <RegisterPartUnitModal onClose={() => setRegisterOpen(false)} />}
      <PartWriteOffModal partId={writeOff?.id ?? null} partName={writeOff?.name} open={!!writeOff} onClose={() => setWriteOff(null)} />
    </Card>
  );
}

/** Раздел про "в остатки и стеллажи нужно добавить возможность ставить на
 * учёт новые партии" — та же регистрация, что уже есть на "Учёт п/ф"
 * (createPartUnit), но доступная прямо отсюда, включая деталь, у которой
 * пока вообще нет ни одной партии (и потому нет строки в этой таблице). */
function RegisterPartUnitModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Оприходовать партию (без списания заготовки)" open onCancel={onClose} footer={null} destroyOnHidden width={480}>
      <RegisterPartUnitForm onDone={onClose} />
    </Modal>
  );
}

/** Форма оприходования партии п/ф — в окне «Остатков» и на «Приёмке» (14.10). */
export function RegisterPartUnitForm({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient();
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [round, setRound] = useState(0); // после записи — пустой выбор детали
  const [form] = Form.useForm<{
    quantity_pieces: number;
    stage_id?: number;
    manufactured_at?: Dayjs;
    film_restriction?: string | null;
    note?: string;
  }>();

  const mintMutation = useMutation({
    mutationFn: (v: {
      quantity_pieces: number;
      stage_id?: number;
      manufactured_at?: Dayjs;
      film_restriction?: string | null;
      note?: string;
    }) =>
      createPartUnit({
        part_id: selectedPart!.id,
        quantity_pieces: v.quantity_pieces,
        stage_id: v.stage_id,
        manufactured_at: v.manufactured_at ? v.manufactured_at.format("YYYY-MM-DD") : undefined,
        film_restriction: v.film_restriction,
        note: v.note,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Партия оприходована");
      form.resetFields();
      setSelectedPart(null);
      setRound((n) => n + 1);
      onDone?.();
    },
    onError: () => message.error("Не удалось зарегистрировать партию — у детали настроены этапы?"),
  });

  return (
      <Form
        layout="vertical"
        form={form}
        onFinish={(v) => {
          if (!selectedPart) {
            message.warning("Выберите деталь");
            return;
          }
          mintMutation.mutate(v);
        }}
      >
        <Form.Item label="Деталь">
          <PartSelect
            key={round}
            onSelect={(p) => {
              setSelectedPart(p);
              form.setFieldValue("stage_id", undefined);
            }}
            placeholder="Найдите деталь в справочнике"
            filmFilter
          />
          {selectedPart && <Typography.Text type="secondary">Выбрано: {selectedPart.name}</Typography.Text>}
        </Form.Item>
        {selectedPart && <RegistrationStageField part={selectedPart} />}
        <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item
          name="manufactured_at"
          label="Дата изготовления (опционально)"
          extra="Партии расходуются от самой старой при отчёте о готовых деталях. Не указано — сегодня."
        >
          <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" placeholder="Сегодня" disabledDate={(d) => d.isAfter(Date.now(), "day")} />
        </Form.Item>
        <Form.Item
          name="film_restriction"
          label="Пометка по плёнке (необязательно)"
          extra={
            selectedPart && isStoevayaMk(selectedPart.name)
              ? "Для стоевых МК: укажите «ПЭТ», если паз выполнен специально под плёнку ПЭТ. Для остальных — без ограничений."
              : "Например: ПЭТ, с кромкой, ламис — видна на партии полуфабриката."
          }
        >
          <FilmRestrictionPicker />
        </Form.Item>
        <Form.Item name="note" label="Заметка (опционально)">
          <Input />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mintMutation.isPending}>
          Оприходовать
        </Button>
      </Form>
  );
}
