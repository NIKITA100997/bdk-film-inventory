import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Space, Typography, Input, Select, Checkbox, Table, Tag, Button, Modal, Form, InputNumber, DatePicker, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dayjs } from "dayjs";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { createPartUnit, listPartUnits, type PartUnit } from "../../../api/partUnits";
import { listAreas } from "../../../api/areas";
import { exportToExcel } from "../../../utils/excel";
import { useAuth } from "../../../auth/AuthContext";
import PartSelect from "../../../components/PartSelect";
import type { Part } from "../../../api/dictionaries";

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
  const { user } = useAuth();
  const canManage = !!user?.is_superuser || !!user?.permissions.includes("part_units.manage");
  // Раздел про "в остатки и стеллажи нужно добавить возможность ставить
  // на учёт новые партии" — раньше единственный вход в регистрацию был
  // через "Учёт п/ф", а деталь без единой партии вообще не попадала в
  // этот список (группировка строится ИЗ существующих партий) — то есть
  // для новой детали здесь просто негде было нажать "добавить". Модалка
  // ниже не завязана на конкретную строку — свой выбор детали, как в
  // форме "Учёт п/ф".
  const [registerOpen, setRegisterOpen] = useState(false);
  const [search, setSearch] = useState("");
  // Раздел про удобство работы мастера участка п/ф — у аккаунта с
  // закреплённым участком (см. isUchastka в MaterialsExplorer.tsx, тот же
  // приём) экран по умолчанию открывается уже отфильтрованным на "что у
  // меня", а не пустым "выберите участок" каждый раз заново.
  const [areaFilter, setAreaFilter] = useState<string | undefined>(user?.area ?? undefined);
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

  const exportRows = () =>
    exportToExcel(
      "ostatki-pf.xlsx",
      filtered.map((g) => ({
        part: g.partName,
        available: Math.round(g.available * 100) / 100,
        stages: g.byStage.map((s) => `${s.stageName}: ${Math.round(s.qty * 100) / 100}`).join(", "),
        areas: g.byArea.map((a) => `${a.area ? areaLabel(a.area) : "склад"}: ${Math.round(a.qty * 100) / 100}`).join(", "),
        unplaced: g.unplacedCount,
      })),
      [
        { key: "part", header: "Деталь" },
        { key: "available", header: "Доступно, шт" },
        { key: "stages", header: "По этапам" },
        { key: "areas", header: "По участкам" },
        { key: "unplaced", header: "Без адреса" },
      ],
    );

  return (
    <Card
      title="Остатки п/ф"
      extra={
        <Space size={8}>
          {canManage && (
            <Button size="small" type="primary" onClick={() => setRegisterOpen(true)}>
              + Зарегистрировать партию
            </Button>
          )}
          <Button size="small" onClick={exportRows}>
            Экспорт в Excel
          </Button>
        </Space>
      }
    >
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

      <ResponsiveTable<PartStockGroup>
        tableKey="part-stock"
        lockedColumns={["Деталь"]}
        size="small"
        tableLayout="fixed"
        rowKey="partId"
        loading={unitsQuery.isLoading}
        dataSource={filtered}
        pagination={{ pageSize: 30 }}
        scroll={{ x: "max-content" }}
        onRow={(g) => ({ onClick: () => navigate("/part-card", { state: { partId: g.partId } }), style: { cursor: "pointer" } })}
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
        ]}
      />

      {registerOpen && <RegisterPartUnitModal onClose={() => setRegisterOpen(false)} />}
    </Card>
  );
}

/** Раздел про "в остатки и стеллажи нужно добавить возможность ставить на
 * учёт новые партии" — та же регистрация, что уже есть на "Учёт п/ф"
 * (createPartUnit), но доступная прямо отсюда, включая деталь, у которой
 * пока вообще нет ни одной партии (и потому нет строки в этой таблице). */
function RegisterPartUnitModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [selectedPart, setSelectedPart] = useState<Part | null>(null);
  const [form] = Form.useForm<{
    quantity_pieces: number;
    stage_id?: number;
    manufactured_at?: Dayjs;
    issue: boolean;
    note?: string;
  }>();

  const mintMutation = useMutation({
    mutationFn: (v: { quantity_pieces: number; stage_id?: number; manufactured_at?: Dayjs; issue: boolean; note?: string }) =>
      createPartUnit({
        part_id: selectedPart!.id,
        quantity_pieces: v.quantity_pieces,
        stage_id: v.stage_id,
        manufactured_at: v.manufactured_at ? v.manufactured_at.format("YYYY-MM-DD") : undefined,
        issue: v.issue,
        note: v.note,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["part-units"] });
      message.success("Партия зарегистрирована");
      onClose();
    },
    onError: () => message.error("Не удалось зарегистрировать партию — у детали настроены этапы?"),
  });

  return (
    <Modal title="Зарегистрировать партию" open onCancel={onClose} footer={null} destroyOnHidden width={480}>
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
            onSelect={(p) => {
              setSelectedPart(p);
              form.setFieldValue("stage_id", undefined);
            }}
            placeholder="Найдите деталь в справочнике"
          />
          {selectedPart && <Typography.Text type="secondary">Выбрано: {selectedPart.name}</Typography.Text>}
        </Form.Item>
        {selectedPart && selectedPart.stages.length > 1 && (
          <Form.Item
            name="stage_id"
            label="Начальный этап"
            extra="Партия уже прошла часть маршрута и заводится в систему только сейчас — по умолчанию первый этап."
          >
            <Select
              allowClear
              placeholder={selectedPart.stages[0].name}
              options={[...selectedPart.stages]
                .sort((a, b) => a.sequence_order - b.sequence_order)
                .map((s) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
        )}
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
        <Form.Item name="issue" valuePropName="checked" initialValue={false}>
          <Checkbox>Сразу выдать участку (участок — из выбранного этапа)</Checkbox>
        </Form.Item>
        <Form.Item name="note" label="Заметка (опционально)">
          <Input />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={mintMutation.isPending}>
          Зарегистрировать
        </Button>
      </Form>
    </Modal>
  );
}
