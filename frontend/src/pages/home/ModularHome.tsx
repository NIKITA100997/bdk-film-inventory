import { Suspense, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, Checkbox, Col, Drawer, List, Row, Space, Spin, Typography, message } from "antd";
import { ArrowDownOutlined, ArrowUpOutlined, SettingOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "react-router-dom";
import dayjs from "dayjs";
import { useAuth } from "../../auth/AuthContext";
import { getHomeModules, setHomeModules } from "../../api/home";
import { useInbox } from "../../components/InboxList";
import { apiErrorMessage } from "../../utils/apiError";
import { isOnboardingSeen } from "../../utils/onboarding";
import OnboardingCard from "../../components/OnboardingCard";
import { MODULES, defaultModules, renderModule, type HomeModule } from "./homeModules";

/** «Общее» (28.10): модульная главная — рабочие модули сотрудника, набор по
 * ролям, каждый меняет свой («Настроить»): включить, выключить, порядок.
 * Набор хранится на сервере — одинаковый на всех устройствах. */
export default function ModularHome() {
  const { user } = useAuth();
  const location = useLocation();
  const q = useQuery({ queryKey: ["home-modules"], queryFn: getHomeModules, staleTime: Infinity });
  const inbox = useInbox();
  const urgent = (inbox.data ?? []).some((i) => i.level === "urgent");
  const [editing, setEditing] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  useEffect(() => {
    if (!user) return;
    const forced = (location.state as { showOnboarding?: boolean } | null)?.showOnboarding;
    if (forced || !isOnboardingSeen(user.id)) setShowOnboarding(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, user?.id]);

  const available = useMemo(() => (user ? MODULES.filter((m) => m.available(user)) : []), [user]);
  if (!user) return null;
  const keys = (q.data ?? defaultModules(user)).filter((k) => available.some((m) => m.key === k));
  const shown = keys.map((k) => available.find((m) => m.key === k)!);
  const custom = q.data != null;

  // узкие модули — парами в строку, рабочие панели — во всю ширину, в порядке набора
  const rows: HomeModule[][] = [];
  for (const m of shown) {
    const last = rows[rows.length - 1];
    if (!m.wide && last && last.length === 1 && !last[0].wide) last.push(m);
    else rows.push([m]);
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      <Space align="center" style={{ justifyContent: "space-between", width: "100%" }}>
        <Space align="baseline" size={12}>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Общее
          </Typography.Title>
          <Typography.Text type="secondary">{dayjs().format("dddd, D MMMM")}</Typography.Text>
        </Space>
        <Button icon={<SettingOutlined />} onClick={() => setEditing(true)}>
          Настроить
        </Button>
      </Space>
      {showOnboarding && <OnboardingCard onClose={() => setShowOnboarding(false)} />}
      {q.isLoading ? (
        <Spin />
      ) : shown.length === 0 ? (
        <Card>
          <Typography.Text type="secondary">Модулей нет — «Настроить», чтобы добавить.</Typography.Text>
        </Card>
      ) : (
        rows.map((row) => (
          <Row key={row.map((m) => m.key).join()} gutter={[16, 16]}>
            {row.map((m) => (
              <Col key={m.key} xs={24} lg={m.wide || row.length === 1 ? 24 : 12}>
                <Card
                  size="small"
                  className={`card-accent-${m.key === "inbox" ? (urgent ? "red" : "blue") : m.accent ?? "orange"}`}
                  title={
                    m.key === "inbox" && (inbox.data?.length ?? 0) > 0 ? (
                      <span>
                        {m.title} <Badge count={inbox.data!.length} color={urgent ? "#C0392B" : "#2F6FB2"} />
                      </span>
                    ) : (
                      m.title
                    )
                  }
                  extra={m.link ? <Link to={m.link}>Открыть полностью →</Link> : null}
                  styles={{ body: { minHeight: 48 } }}
                >
                  <Suspense fallback={<Spin size="small" />}>{renderModule(m, user)}</Suspense>
                </Card>
              </Col>
            ))}
          </Row>
        ))
      )}
      {editing && <HomeSettings available={available} current={keys} custom={custom} defaults={defaultModules(user)} onClose={() => setEditing(false)} />}
    </Space>
  );
}

function HomeSettings({
  available,
  current,
  custom,
  defaults,
  onClose,
}: {
  available: HomeModule[];
  current: string[];
  custom: boolean;
  defaults: string[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [order, setOrder] = useState<string[]>([...current, ...available.map((m) => m.key).filter((k) => !current.includes(k))]);
  const [on, setOn] = useState<Set<string>>(new Set(current));
  const save = useMutation({
    mutationFn: (modules: string[] | null) => setHomeModules(modules),
    onSuccess: (r) => {
      qc.setQueryData(["home-modules"], r);
      message.success(r == null ? "Вернули стандартный набор" : "Сохранено");
      onClose();
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не сохранилось")),
  });
  const move = (i: number, d: -1 | 1) =>
    setOrder((o) => {
      const n = [...o];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });
  const byKey = new Map(available.map((m) => [m.key, m]));
  return (
    <Drawer
      open
      width={520}
      title="Мои модули на «Общем»"
      onClose={onClose}
      extra={
        <Space>
          {custom && (
            <Button onClick={() => save.mutate(null)} loading={save.isPending}>
              Стандартный набор
            </Button>
          )}
          <Button type="primary" loading={save.isPending} onClick={() => save.mutate(order.filter((k) => on.has(k)))}>
            Сохранить
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        Отметьте, что нужно в работе, стрелками — порядок. Набор сохраняется у вас и одинаков на телефоне, планшете и компьютере.
        Стандартный для вас: {defaults.map((k) => byKey.get(k)?.title).filter(Boolean).join(", ")}.
      </Typography.Paragraph>
      <List
        dataSource={order}
        renderItem={(k, i) => {
          const m = byKey.get(k)!;
          return (
            <List.Item
              actions={[
                <Button key="up" size="small" type="text" aria-label="Выше" icon={<ArrowUpOutlined />} disabled={i === 0} onClick={() => move(i, -1)} />,
                <Button key="down" size="small" type="text" aria-label="Ниже" icon={<ArrowDownOutlined />} disabled={i === order.length - 1} onClick={() => move(i, 1)} />,
              ]}
            >
              <Checkbox
                checked={on.has(k)}
                onChange={(e) =>
                  setOn((s) => {
                    const n = new Set(s);
                    if (e.target.checked) n.add(k);
                    else n.delete(k);
                    return n;
                  })
                }
              >
                <Space direction="vertical" size={0}>
                  <b>{m.title}</b>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{m.hint}</Typography.Text>
                </Space>
              </Checkbox>
            </List.Item>
          );
        }}
      />
    </Drawer>
  );
}
