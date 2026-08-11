import { Card, Typography, Form, Input, InputNumber, Button, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCalcSettings, updateCalcSettings } from "../../api/abc";

/** Параметры расчётов (выделено из бывших общих "Настроек" по итогам
 * продуктового разбора — пороги для ABC/донор-рекомендаций и заявок
 * поставщику не связаны со стеллажами, у них разная аудитория по смыслу,
 * даже если сейчас обеими управляет один и тот же логист). */
export default function CalcSettingsAdmin() {
  const qc = useQueryClient();
  const calcSettingsQuery = useQuery({ queryKey: ["calc-settings"], queryFn: getCalcSettings });
  const calcSettingsMutation = useMutation({
    mutationFn: updateCalcSettings,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["calc-settings"] });
      message.success("Настройки сохранены");
    },
  });

  return (
    <Card loading={calcSettingsQuery.isLoading}>
      <Typography.Title level={4}>Параметры расчётов</Typography.Title>
      {calcSettingsQuery.data && (
        <Form
          layout="vertical"
          style={{ maxWidth: 480 }}
          initialValues={calcSettingsQuery.data}
          onFinish={(v) => calcSettingsMutation.mutate(v)}
        >
          <Form.Item name="min_useful_width_mm" label="Минимальная полезная ширина, мм" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="abc_recalc_period_days" label="Период пересчёта ABC, дни" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="cells_per_strip_shelf" label="Ячеек на полке штрипсового стеллажа" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="stale_threshold_days" label="Порог «давно не двигалась», дни" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item
            name="shortage_note_template"
            label="Шаблон комментария заявки поставщику"
            rules={[{ required: true }]}
            extra="Плейсхолдеры: {material} {color} {thickness} {shortage_m2}"
          >
            <Input />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={calcSettingsMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      )}
    </Card>
  );
}
