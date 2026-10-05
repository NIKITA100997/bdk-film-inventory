import { useState } from "react";
import { Alert, Button, InputNumber, Space, Table, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listCurrencies, setCurrencyRate, type Currency } from "../../api/prices";
import { apiErrorMessage } from "../../utils/apiError";
import { fmtDateTime } from "../../utils/dates";

/** Курсы валют (05.10): общий курс на всё приложение — по нему цены в
 * евро и долларах пересчитываются в рубли в себестоимости и прайсе. */
export default function CurrencyRatesAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["currencies"], queryFn: listCurrencies });
  const [draft, setDraft] = useState<Record<string, number | null>>({});
  const save = useMutation({
    mutationFn: ({ code, rate }: { code: string; rate: number | null }) => setCurrencyRate(code, rate),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ["currencies"] });
      qc.invalidateQueries({ queryKey: ["prices"] });
      setDraft((d) => {
        const n = { ...d };
        delete n[c.code];
        return n;
      });
      message.success(`Курс ${c.code} сохранён`);
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить курс")),
  });
  const missing = (q.data ?? []).filter((c) => c.rate == null);
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%", maxWidth: 720 }}>
      <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
        У каждой позиции цена заводится в своей валюте (рубли, евро, доллары); в рубли она пересчитывается по этому курсу —
        одному на всё приложение. Поменяли курс — себестоимость и прайс сразу считаются по новому.
      </Typography.Paragraph>
      {missing.length > 0 && (
        <Alert type="warning" showIcon message={`Курс не задан: ${missing.map((c) => c.name).join(", ")} — цены в этой валюте в рубли не пересчитываются`} />
      )}
      <Table<Currency>
        size="small"
        rowKey="code"
        pagination={false}
        loading={q.isLoading}
        dataSource={q.data ?? []}
        columns={[
          { title: "Валюта", render: (_, c) => `${c.name} (${c.symbol})` },
          {
            title: "Курс, ₽ за 1",
            render: (_, c) =>
              c.code === "RUB" ? (
                "1"
              ) : (
                <Space>
                  <InputNumber
                    min={0.0001}
                    step={0.01}
                    style={{ width: 140 }}
                    placeholder="не задан"
                    value={c.code in draft ? draft[c.code] : c.rate}
                    onChange={(v) => setDraft((d) => ({ ...d, [c.code]: v ?? null }))}
                  />
                  <Button
                    size="small"
                    type="primary"
                    disabled={!(c.code in draft)}
                    loading={save.isPending && save.variables?.code === c.code}
                    onClick={() => save.mutate({ code: c.code, rate: draft[c.code] })}
                  >
                    Сохранить
                  </Button>
                </Space>
              ),
          },
          { title: "Изменён", render: (_, c) => (c.code === "RUB" ? "—" : fmtDateTime(c.updated_at)) },
        ]}
      />
    </Space>
  );
}
