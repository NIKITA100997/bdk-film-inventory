import { useState } from "react";
import {
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Select,
  Typography,
  Statistic,
  Row,
  Col,
  List,
  Tag,
  Alert,
  message,
  Divider,
} from "antd";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  startSession,
  scanUnit,
  closeSession,
  resolveShortage,
  type InventoryScopeType,
  type InventorySession,
  type ScanResult,
  type CloseSessionResult,
} from "../../api/inventory";
import { listRacks } from "../../api/storage";
import { listMaterialSkus } from "../../api/dictionaries";
import { skuLabel } from "../../api/units";
import DictAutoComplete from "../../components/DictAutoComplete";

const scopeOptions = [
  { value: "rack", label: "Стеллаж" },
  { value: "warehouse", label: "Весь склад" },
  { value: "material_sku", label: "Позиция материала" },
];

export default function Inventory() {
  const [session, setSession] = useState<InventorySession | null>(null);
  const [scanLog, setScanLog] = useState<ScanResult[]>([]);
  const [closeResult, setCloseResult] = useState<CloseSessionResult | null>(null);
  const [scopeType, setScopeType] = useState<InventoryScopeType>("rack");
  const [scanForm] = Form.useForm();
  const [unitIdKnown, setUnitIdKnown] = useState(true);

  const racksQuery = useQuery({ queryKey: ["racks"], queryFn: listRacks, enabled: scopeType === "rack" });
  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: listMaterialSkus, enabled: scopeType === "material_sku" });

  const startMutation = useMutation({
    mutationFn: startSession,
    onSuccess: (s) => {
      setSession(s);
      setScanLog([]);
      setCloseResult(null);
    },
    onError: () => message.error("Не удалось открыть сессию"),
  });

  const scanMutation = useMutation({
    mutationFn: (values: Record<string, unknown>) => scanUnit(session!.id, values as never),
    onSuccess: (result) => {
      setScanLog((log) => [result, ...log]);
      setSession((s) => (s ? { ...s, scanned_count: s.scanned_count + 1 } : s));
      scanForm.resetFields(["unit_id", "material", "color", "thickness", "manufacturer", "width_mm", "length_m"]);
      message.success(
        result.outcome === "confirmed"
          ? "На месте"
          : result.outcome === "moved"
            ? "Адрес скорректирован"
            : "Излишек — создана новая единица",
      );
    },
    onError: () => message.error("Не удалось обработать скан"),
  });

  const closeMutation = useMutation({
    mutationFn: () => closeSession(session!.id),
    onSuccess: (result) => {
      setCloseResult(result);
      setSession(result.session);
    },
    onError: () => message.error("Не удалось закрыть сессию"),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ unitId, action }: { unitId: number; action: "spisat" | "vernut_v_poisk" }) =>
      resolveShortage(session!.id, unitId, action),
    onSuccess: (_, vars) => {
      setCloseResult((r) => (r ? { ...r, shortages: r.shortages.filter((s) => s.id !== vars.unitId) } : r));
      message.success("Решение сохранено");
    },
  });

  if (!session) {
    return (
      <Card>
        <Typography.Title level={4}>Инвентаризация</Typography.Title>
        <Typography.Paragraph type="secondary">
          Тот же режим используется и для первичного внесения остатков — тогда почти каждый скан попадает в «излишек».
        </Typography.Paragraph>
        <Form
          layout="vertical"
          onFinish={(v) =>
            startMutation.mutate({
              scope_type: v.scope_type,
              scope_ref_id: v.scope_ref_id,
            })
          }
        >
          <Form.Item name="scope_type" label="Область" rules={[{ required: true }]} initialValue="rack">
            <Select options={scopeOptions} onChange={(v) => setScopeType(v)} />
          </Form.Item>
          {scopeType === "rack" && (
            <Form.Item name="scope_ref_id" label="Стеллаж" rules={[{ required: true }]}>
              <Select
                loading={racksQuery.isLoading}
                options={(racksQuery.data ?? []).map((r) => ({ value: r.id, label: r.code }))}
              />
            </Form.Item>
          )}
          {scopeType === "material_sku" && (
            <Form.Item name="scope_ref_id" label="Позиция материала" rules={[{ required: true }]}>
              <Select
                loading={skusQuery.isLoading}
                options={(skusQuery.data ?? []).map((s) => ({ value: s.id, label: skuLabel(s) }))}
              />
            </Form.Item>
          )}
          <Button type="primary" htmlType="submit" block loading={startMutation.isPending}>
            Начать сессию
          </Button>
        </Form>
      </Card>
    );
  }

  if (session.status === "closed") {
    return (
      <Card>
        <Typography.Title level={4}>Сессия №{session.id} закрыта</Typography.Title>
        {closeResult && (
          <>
            <Row gutter={16} style={{ marginBottom: 16 }}>
              <Col span={6}>
                <Statistic title="Подтверждено" value={closeResult.confirmed_count} />
              </Col>
              <Col span={6}>
                <Statistic title="Перемещено" value={closeResult.moved_count} />
              </Col>
              <Col span={6}>
                <Statistic title="Излишков" value={closeResult.surplus_count} />
              </Col>
              <Col span={6}>
                <Statistic title="Недостач" value={closeResult.shortages.length} valueStyle={{ color: "#C97A2B" }} />
              </Col>
            </Row>
            {closeResult.shortages.length > 0 && (
              <>
                <Divider>Недостачи — решение по каждой</Divider>
                <List
                  dataSource={closeResult.shortages}
                  renderItem={(s) => (
                    <List.Item
                      actions={[
                        <Button
                          key="write-off"
                          danger
                          size="small"
                          onClick={() => resolveMutation.mutate({ unitId: s.id, action: "spisat" })}
                        >
                          Списать
                        </Button>,
                        <Button
                          key="keep"
                          size="small"
                          onClick={() => resolveMutation.mutate({ unitId: s.id, action: "vernut_v_poisk" })}
                        >
                          Вернуть в поиск
                        </Button>,
                      ]}
                    >
                      № {s.id} — {s.width_mm} мм × {s.length_m} м, числилась в {s.location_code}
                    </List.Item>
                  )}
                />
              </>
            )}
          </>
        )}
        <Button block style={{ marginTop: 16 }} onClick={() => setSession(null)}>
          Новая сессия
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <Typography.Title level={4}>Сессия №{session.id} — в процессе</Typography.Title>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={12}>
          <Statistic title="Ожидалось" value={session.expected_count} />
        </Col>
        <Col span={12}>
          <Statistic title="Отсканировано" value={session.scanned_count} />
        </Col>
      </Row>

      <Form
        form={scanForm}
        layout="vertical"
        onFinish={(v) => {
          const payload: Record<string, unknown> = { location_code: v.location_code };
          if (unitIdKnown && v.unit_id) payload.unit_id = v.unit_id;
          if (!unitIdKnown) {
            Object.assign(payload, {
              material: v.material,
              color: v.color,
              thickness: v.thickness,
              manufacturer: v.manufacturer,
              width_mm: v.width_mm,
              length_m: v.length_m,
            });
          }
          scanMutation.mutate(payload);
        }}
      >
        <Form.Item label="Физический адрес, где сканируете">
          <Form.Item name="location_code" noStyle rules={[{ required: true }]}>
            <Input placeholder="Р-3-07" />
          </Form.Item>
        </Form.Item>

        <Button
          type="dashed"
          block
          style={{ marginBottom: 12 }}
          onClick={() => setUnitIdKnown((v) => !v)}
        >
          {unitIdKnown ? "ID не читается — создать как новую" : "Вернуться к вводу ID"}
        </Button>

        {unitIdKnown ? (
          <Form.Item name="unit_id" label="ID единицы (по бирке/QR)" rules={[{ required: true }]}>
            <InputNumber style={{ width: "100%" }} autoFocus />
          </Form.Item>
        ) : (
          <>
            <Form.Item name="material" label="Материал" rules={[{ required: true }]}>
              <DictAutoComplete kind="materials" />
            </Form.Item>
            <Form.Item name="color" label="Цвет" rules={[{ required: true }]}>
              <DictAutoComplete kind="colors" />
            </Form.Item>
            <Form.Item name="thickness" label="Толщина, мм" rules={[{ required: true }]}>
              <InputNumber min={0} step={0.01} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="manufacturer" label="Производитель" rules={[{ required: true }]}>
              <DictAutoComplete kind="manufacturers" />
            </Form.Item>
            <Form.Item name="width_mm" label="Ширина, мм" rules={[{ required: true }]}>
              <InputNumber min={1} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="length_m" label="Длина, м" rules={[{ required: true }]}>
              <InputNumber min={0.1} step={0.1} style={{ width: "100%" }} />
            </Form.Item>
          </>
        )}

        <Button type="primary" htmlType="submit" block loading={scanMutation.isPending}>
          Отсканировать
        </Button>
      </Form>

      {scanLog.length > 0 && (
        <List
          style={{ marginTop: 16 }}
          size="small"
          dataSource={scanLog}
          renderItem={(item) => (
            <List.Item>
              <Tag
                color={item.outcome === "confirmed" ? "green" : item.outcome === "moved" ? "orange" : "blue"}
              >
                {item.outcome === "confirmed" ? "На месте" : item.outcome === "moved" ? "Перемещено" : "Излишек"}
              </Tag>
              № {item.unit.id} — {item.unit.width_mm} мм × {item.unit.length_m} м
            </List.Item>
          )}
        />
      )}

      <Alert
        style={{ marginTop: 16 }}
        type="warning"
        showIcon
        message="Закрытие сессии"
        description="После закрытия всё, что осталось не отсканированным из ожидаемого списка, попадёт в недостачи."
        action={
          <Button danger size="small" loading={closeMutation.isPending} onClick={() => closeMutation.mutate()}>
            Закрыть сессию
          </Button>
        }
      />
    </Card>
  );
}
