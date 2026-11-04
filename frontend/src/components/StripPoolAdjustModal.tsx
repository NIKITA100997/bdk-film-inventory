import { useState, useEffect } from "react";
import { Modal, Form, InputNumber, Input, Typography, Space, Tag, Alert, message, Button } from "antd";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { adjustStripPool } from "../api/production";
import { apiErrorMessage } from "../utils/apiError";

interface Props {
  open: boolean;
  onClose: () => void;
  area: string;
  material: string | null;
  materialId?: number | null;
  color: string | null;
  colorId?: number | null;
  thicknessId?: number | null;
  stripWidthMm: number;
  currentStockM?: number | null;
  deficitM?: number | null;
}

export default function StripPoolAdjustModal({
  open,
  onClose,
  area,
  material,
  materialId,
  color,
  colorId,
  thicknessId,
  stripWidthMm,
  currentStockM = 0,
  deficitM = 0,
}: Props) {
  const qc = useQueryClient();
  const [actualM, setActualM] = useState<number | null>(null);
  const [note, setNote] = useState<string>("");

  useEffect(() => {
    if (open) {
      setActualM(currentStockM ?? 0);
      setNote("");
    }
  }, [open, currentStockM]);

  const prevM = currentStockM ?? 0;
  const delta = actualM != null ? Math.round((actualM - prevM) * 100) / 100 : 0;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!materialId || !colorId) {
        throw new Error("Не указан идентификатор материала или цвета строки");
      }
      if (actualM == null || actualM < 0) {
        throw new Error("Укажите корректный фактический остаток в метрах");
      }
      return adjustStripPool({
        area,
        material_id: materialId,
        color_id: colorId,
        thickness_id: thicknessId ?? null,
        target_width_mm: stripWidthMm,
        actual_meters: actualM,
        note: note.trim() || undefined,
      });
    },
    onSuccess: (data) => {
      message.success(`Остаток пула обновлён: ${data.actual_meters} м (дельта: ${data.delta_meters > 0 ? "+" : ""}${data.delta_meters} м)`);
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["production-monitor"] });
      qc.invalidateQueries({ queryKey: ["daily-plan"] });
      onClose();
    },
    onError: (err) => {
      message.error(apiErrorMessage(err, "Не удалось обновить остаток пула"));
    },
  });

  return (
    <Modal
      title={`Экспресс-сверка пула штрипсов · ${area}`}
      open={open}
      onCancel={onClose}
      onOk={() => mutation.mutate()}
      okButtonProps={{ disabled: actualM == null || actualM < 0 || !materialId || !colorId }}
      confirmLoading={mutation.isPending}
      okText="Применить остаток"
      cancelText="Отмена"
      destroyOnClose
    >
      <Space direction="vertical" size="middle" style={{ width: "100%", marginTop: 8 }}>
        <Alert
          type="info"
          showIcon
          message={
            <Space wrap>
              <Typography.Text strong>{material ?? "Плёнка"}</Typography.Text>
              <span>·</span>
              <Typography.Text>{color ?? "—"}</Typography.Text>
              <span>·</span>
              <Tag color="blue">{stripWidthMm} мм</Tag>
            </Space>
          }
          description={
            <div style={{ marginTop: 6, fontSize: 13 }}>
              <span>Текущий расчётный остаток в пуле: <b>{prevM} м</b></span>
              {deficitM != null && deficitM > 0 && (
                <div style={{ marginTop: 4 }}>
                  <Tag color="error">Накоплен овердрафт: -{deficitM} м</Tag>
                </div>
              )}
            </div>
          }
        />

        <Form layout="vertical">
          <Form.Item
            label="Фактический остаток на участке (м)"
            required
            help="Укажите реальный суммарный метраж штрипсов этой ширины у станка"
          >
            <InputNumber
              size="large"
              style={{ width: "100%" }}
              min={0}
              step={10}
              precision={1}
              value={actualM}
              onChange={(v) => setActualM(v)}
              placeholder="Введите метры..."
            />
          </Form.Item>
          <Space wrap style={{ marginTop: -8, marginBottom: 16 }}>
            {[10, 50, 100].map((meters) => (
              <Button key={meters} size="large" onClick={() => setActualM((actualM ?? 0) + meters)}>
                +{meters} м
              </Button>
            ))}
            <Button size="large" onClick={() => setActualM(0)}>= 0 м (пусто)</Button>
          </Space>

          <div style={{ marginBottom: 16 }}>
            {delta > 0 ? (
              <Tag color="success" style={{ fontSize: 13, padding: "4px 8px" }}>
                + {delta} м (будет оприходовано как излишек пула)
              </Tag>
            ) : delta < 0 ? (
              <Tag color="warning" style={{ fontSize: 13, padding: "4px 8px" }}>
                {delta} м (будет списано по FIFO как недостача)
              </Tag>
            ) : (
              <Tag color="default" style={{ fontSize: 13, padding: "4px 8px" }}>
                Остаток совпадает (0 м изменений)
              </Tag>
            )}
          </div>

          <Form.Item label="Примечание мастера / причина сверки (опционально)">
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Например: замер рулеткой у станка / привезли пачку 100м"
            />
          </Form.Item>
        </Form>
      </Space>
    </Modal>
  );
}
