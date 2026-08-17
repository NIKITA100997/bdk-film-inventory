import { useState } from "react";
import { Alert, Button, Card, Form, InputNumber, Select, Typography, List, Row, Col, Statistic, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { receiveUnits, printLabelsBatch, skuLabel, type MaterialUnit, type ReceiveRequest } from "../../api/units";
import { listRacks, getRackOccupancy } from "../../api/storage";
import DictAutoComplete from "../../components/DictAutoComplete";

type LineValues = {
  shelf: number;
  material: string;
  color: string;
  thickness: string;
  manufacturer: string;
  width_mm: number;
  length_m: number;
  quantity: number;
};

// Плейсхолдеры вместо УПД/паллеты — эта плёнка физически уже стоит на
// складе с момента до перехода на систему, реального документа поставки
// нет и не будет; тот же приём, что уже используется для регистрации
// единицы вне сессии приёмки (MaterialsExplorer.tsx).
const NO_DOCUMENT_UPD = "Без документа";
const NO_DOCUMENT_PALLET = "-";

/** Ввод первоначальных остатков (раздел про уже заполненные стеллажи) —
 * отдельный от обычной приёмки сценарий: не "пришла партия от
 * поставщика, найти место", а "стою у стеллажа, который уже полон,
 * считаю и заношу по полкам". Тот же бэкенд, что у приёмки (POST
 * /units/receive поддерживает явный location_code — единица сразу
 * встаёт на нужную полку без отдельного вызова автоподбора места), та
 * же печать этикеток пачкой в конце (printLabelsBatch), что в
 * Receive.tsx — просто организовано вокруг стеллажа, а не вокруг УПД. */
export default function InitialStock() {
  const qc = useQueryClient();
  const [rackId, setRackId] = useState<number | null>(null);
  const [sessionUnits, setSessionUnits] = useState<MaterialUnit[]>([]);
  const [lastAdded, setLastAdded] = useState<MaterialUnit[] | null>(null);
  const [finished, setFinished] = useState(false);
  const [lineForm] = Form.useForm<LineValues>();

  const racksQuery = useQuery({ queryKey: ["racks"], queryFn: () => listRacks() });
  const activeRacks = (racksQuery.data ?? []).filter((r) => r.is_active);
  const selectedRack = activeRacks.find((r) => r.id === rackId) ?? null;

  const occupancyQuery = useQuery({
    queryKey: ["rack-occupancy", rackId],
    queryFn: () => getRackOccupancy(rackId!),
    enabled: rackId != null,
  });
  const availableShelves = (occupancyQuery.data ?? []).filter((c) => c.units.length < c.capacity);

  const selectedShelfNumber = Form.useWatch("shelf", lineForm);
  const selectedShelf = (occupancyQuery.data ?? []).find((c) => c.shelf === selectedShelfNumber);
  const remainingCapacity = selectedShelf ? selectedShelf.capacity - selectedShelf.units.length : 1;

  const addLineMutation = useMutation({
    mutationFn: (values: LineValues) => {
      const shelfCell = (occupancyQuery.data ?? []).find((c) => c.shelf === values.shelf)!;
      const payload: ReceiveRequest = {
        upd_number: NO_DOCUMENT_UPD,
        pallet_number: NO_DOCUMENT_PALLET,
        material: values.material,
        color: values.color,
        thickness: Number(values.thickness),
        manufacturer: values.manufacturer,
        width_mm: values.width_mm,
        length_m: values.length_m,
        quantity: values.quantity,
        location_code: shelfCell.location_code,
      };
      return receiveUnits(payload);
    },
    onSuccess: (units) => {
      setSessionUnits((s) => [...s, ...units]);
      setLastAdded(units);
      qc.invalidateQueries({ queryKey: ["rack-occupancy", rackId] });
      lineForm.resetFields(["shelf", "quantity"]);
    },
    onError: () => message.error("Не удалось внести остаток — проверьте данные"),
  });

  const newRack = () => {
    setRackId(null);
    setSessionUnits([]);
    setLastAdded(null);
    setFinished(false);
    lineForm.resetFields();
  };

  return (
    <Card>
      <Typography.Title level={4}>Начальные остатки</Typography.Title>

      {!rackId && (
        <>
          <Typography.Paragraph type="secondary">
            Выберите стеллаж, который сейчас пересчитываете — дальше можно быстро внести всё, что на нём физически
            стоит, по полкам, и сразу распечатать этикетки.
          </Typography.Paragraph>
          <Select
            size="large"
            style={{ width: "100%" }}
            placeholder="Стеллаж"
            showSearch
            optionFilterProp="label"
            loading={racksQuery.isLoading}
            options={activeRacks.map((r) => ({
              value: r.id,
              label: `${r.code} (${r.type === "roll" ? "рулонный" : "штрипсовый"}, ${r.shelf_count} полок)`,
            }))}
            onChange={(v) => setRackId(v)}
          />
        </>
      )}

      {rackId && !finished && (
        <>
          <Typography.Paragraph type="secondary">
            Стеллаж {selectedRack?.code}. Выберите полку и опишите, что на ней стоит — материал/цвет/толщина/
            производитель остаются для следующей строки, полку выбирайте заново на каждой.
          </Typography.Paragraph>

          <Form form={lineForm} layout="vertical" onFinish={(v) => addLineMutation.mutate(v)} initialValues={{ quantity: 1 }}>
            <Form.Item name="shelf" label="Полка" rules={[{ required: true }]}>
              <Select
                size="large"
                placeholder={availableShelves.length === 0 ? "Нет свободных полок" : "Выберите полку"}
                disabled={availableShelves.length === 0}
                options={availableShelves.map((c) => ({
                  value: c.shelf,
                  label: c.capacity > 1 ? `Полка ${c.shelf} — ${c.units.length} из ${c.capacity}` : `Полка ${c.shelf} — свободно`,
                }))}
              />
            </Form.Item>
            <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
              <DictAutoComplete kind="materials" />
            </Form.Item>
            <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
              <DictAutoComplete kind="colors" />
            </Form.Item>
            <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
              <DictAutoComplete kind="thicknesses" />
            </Form.Item>
            <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
              <DictAutoComplete kind="manufacturers" />
            </Form.Item>
            <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]}>
              <InputNumber size="large" min={1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
              <InputNumber size="large" min={0.1} step={0.1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="quantity" label="Количество на эту полку" rules={[{ required: true }]}>
              <InputNumber size="large" min={1} max={remainingCapacity} style={{ width: "100%" }} />
            </Form.Item>
            <Button
              size="large"
              type="primary"
              htmlType="submit"
              block
              loading={addLineMutation.isPending}
              disabled={availableShelves.length === 0}
            >
              Добавить и дальше
            </Button>
          </Form>

          {lastAdded && (
            <Alert
              style={{ marginTop: 16 }}
              showIcon
              type="success"
              message={
                lastAdded.length === 1
                  ? `№${lastAdded[0].id} → ${lastAdded[0].location_code}`
                  : `${lastAdded.length} шт → ${lastAdded[0].location_code}`
              }
            />
          )}

          {sessionUnits.length > 0 && (
            <>
              <Typography.Title level={5} style={{ marginTop: 24 }}>
                На этом стеллаже внесено: {sessionUnits.length}
              </Typography.Title>
              <List
                size="small"
                bordered
                dataSource={sessionUnits}
                renderItem={(u) => (
                  <List.Item>
                    № {u.id} — {skuLabel(u.material_sku)}, {u.width_mm}×{u.length_m} — {u.location_code}
                  </List.Item>
                )}
              />
              <Button block style={{ marginTop: 16 }} onClick={() => setFinished(true)}>
                Завершить стеллаж
              </Button>
            </>
          )}
        </>
      )}

      {finished && (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            <Col xs={12} sm={12}>
              <Statistic title="Единиц внесено" value={sessionUnits.length} />
            </Col>
            <Col xs={12} sm={12}>
              <Statistic title="Стеллаж" value={selectedRack?.code ?? "—"} />
            </Col>
          </Row>
          <Button type="primary" block onClick={() => printLabelsBatch(sessionUnits.map((u) => u.id))}>
            Печать всех этикеток
          </Button>
          <Button block style={{ marginTop: 8 }} onClick={newRack}>
            Следующий стеллаж
          </Button>
        </>
      )}
    </Card>
  );
}
