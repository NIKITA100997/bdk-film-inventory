import { useEffect, useState } from "react";
import { Alert, Button, Card, InputNumber, Space, Switch, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getFilmReserveSettings, saveFilmReserveSettings } from "../../api/filmReserve";
import { apiErrorMessage } from "../../utils/apiError";

/** Резерв плёнки под заказ (15.10): включить/выключить всю функцию и запас
 * на брак, пусковые и сделанное сверх заказа — с фактом за 60 дней. */
export default function FilmReserveSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["film-reserve-settings"], queryFn: getFilmReserveSettings });
  const [enabled, setEnabled] = useState(false);
  const [pct, setPct] = useState<number>(12);
  useEffect(() => {
    if (q.data) {
      setEnabled(q.data.enabled);
      setPct(q.data.extra_pct);
    }
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => saveFilmReserveSettings({ enabled, extra_pct: pct }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["film-reserve-settings"] });
      qc.invalidateQueries({ queryKey: ["film-issue-board"] });
      message.success("Настройки резерва сохранены");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  const st = q.data?.stats;
  return (
    <Card title="Резерв плёнки под заказ" loading={q.isLoading} style={{ maxWidth: 720 }}>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          При запуске заказа в производство под строки заданий закрепляются метры на рулонах склада участка (сначала готовые штрипсы,
          потом начатые, потом самые старые рулоны). У заказа клиента — кнопка «Зарезервировать плёнку» для срочных до запуска.
          Закреплённое не выдают и не режут под другой заказ; снять или перехватить резерв может начальник цеха.
        </Typography.Paragraph>
        <Space>
          <Switch checked={enabled} onChange={setEnabled} />
          <span>{enabled ? "Резерв включён" : "Резерв выключен"}</span>
        </Space>
        <Space wrap>
          <span>Запас сверх плана, %</span>
          <InputNumber min={0} max={100} step={0.5} value={pct} onChange={(v) => setPct(v ?? 0)} style={{ width: 100 }} />
          {st && st.suggested_pct > 0 && (
            <Button size="small" onClick={() => setPct(st.suggested_pct)}>
              Взять по факту: {st.suggested_pct} %
            </Button>
          )}
        </Space>
        {st && (
          <Alert
            type="info"
            showIcon
            message={`Факт за ${st.days} дней по заданиям с плёнкой`}
            description={
              st.defect_pct + st.over_plan_pct > 0
                ? `Брак ${st.defect_pct} % (из них пусковые ${st.startup_pct} %), сделано сверх плана ${st.over_plan_pct} % — вместе ${st.suggested_pct} %.`
                : "Отчётов за период нет — запас задайте вручную."
            }
          />
        )}
        <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Сохранить
        </Button>
      </Space>
    </Card>
  );
}
