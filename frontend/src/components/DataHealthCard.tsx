import { useState } from "react";
import { Button, Card, Space, Tag, Tooltip, Typography } from "antd";
import { CheckCircleTwoTone, ReloadOutlined } from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { getDataHealth, type DataHealthCheck } from "../api/control";

const COLOR: Record<DataHealthCheck["level"], string> = { ok: "green", info: "blue", warning: "orange", error: "red" };

/** «Контроль данных» на «Обзоре» (19.10): противоречия в учёте, которые не
 * видно в работе, — число, подсказка, куда идти, примеры. Раз в 10 минут. */
export default function DataHealthCard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showOk, setShowOk] = useState(false);
  const q = useQuery({ queryKey: ["data-health"], queryFn: () => getDataHealth(false), staleTime: 300_000 });
  const checks = q.data?.checks ?? [];
  const visible = showOk ? checks : checks.filter((c) => c.level !== "ok");
  return (
    <Card
      size="small"
      loading={q.isLoading}
      title={
        <Space>
          Контроль данных
          {q.data && (q.data.problems ? <Tag color="orange">замечаний: {q.data.problems}</Tag> : <Tag color="green">в порядке</Tag>)}
        </Space>
      }
      extra={
        <Space size={4}>
          {q.data && <Typography.Text type="secondary" style={{ fontSize: 12 }}>проверено {dayjs(q.data.checked_at).format("HH:mm")}</Typography.Text>}
          <Button
            size="small"
            type="text"
            aria-label="Проверить заново"
            icon={<ReloadOutlined />}
            onClick={async () => qc.setQueryData(["data-health"], await getDataHealth(true))}
          />
        </Space>
      }
    >
      {visible.length === 0 ? (
        <Space>
          <CheckCircleTwoTone twoToneColor="#52c41a" />
          <Typography.Text>Противоречий в данных нет</Typography.Text>
        </Space>
      ) : (
        <Space direction="vertical" size={6} style={{ width: "100%" }}>
          {visible.map((c) => (
            <div key={c.key} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <Tag color={COLOR[c.level]} style={{ minWidth: 44, textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
                {c.count}
              </Tag>
              <div style={{ flex: 1, minWidth: 220 }}>
                {c.path ? <a onClick={() => navigate(c.path!)}>{c.title}</a> : c.title}
                <div style={{ fontSize: 12, color: "#6B6B68" }}>
                  {c.hint}
                  {c.examples.length > 0 && (
                    <Tooltip title={c.examples.join("\n")} overlayStyle={{ whiteSpace: "pre-line", maxWidth: 520 }}>
                      <span style={{ marginLeft: 6, textDecoration: "underline dotted", cursor: "help" }}>примеры</span>
                    </Tooltip>
                  )}
                </div>
              </div>
            </div>
          ))}
        </Space>
      )}
      <Button size="small" type="link" style={{ paddingLeft: 0, marginTop: 4 }} onClick={() => setShowOk((v) => !v)}>
        {showOk ? "Скрыть проверки без замечаний" : `Показать все проверки (${checks.length})`}
      </Button>
    </Card>
  );
}
