import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Form, Input, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import dayjs from "dayjs";
import {
  getBitrixSettings,
  getDealMeta,
  getUserMap,
  listBitrixChats,
  listBitrixUsers,
  listOutbox,
  retryOutbox,
  saveBitrixSettings,
  saveUserMap,
  syncDealsNow,
  testBitrix,
  type BitrixSettings as Settings,
} from "../../api/bitrix";
import { apiErrorMessage } from "../../utils/apiError";

const EVENT_LABEL: Record<string, string> = {
  request_submitted: "новая заявка",
  request_accepted: "заявка принята",
  request_returned: "заявка возвращена",
  promise_changed: "перенос дат",
  purchase_task: "закупка",
  deal_comment: "лента сделки",
  deal_ship_date: "дата отгрузки в сделке",
  lag_digest: "сводка отставаний",
  order_cancelled: "отмена заказа",
  order_reduced: "уменьшение заказа",
  plan_submitted: "план на утверждение",
  plan_approved: "план утверждён",
  plan_returned: "план возвращён",
};

/** Настройки Битрикс24 (12.10): входящий вебхук, чаты служб, кому задачи на
 * закупку, сотрудники программы ↔ пользователи Битрикса, журнал сообщений. */
export default function BitrixSettings() {
  const qc = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["bitrix-settings"], queryFn: getBitrixSettings });
  const [s, setS] = useState<Settings | null>(null);
  useEffect(() => {
    if (settingsQuery.data) setS(settingsQuery.data);
  }, [settingsQuery.data]);
  const connected = !!settingsQuery.data?.webhook_set;
  const chatsQuery = useQuery({ queryKey: ["bitrix-chats"], queryFn: listBitrixChats, enabled: connected, retry: false });
  const bxUsersQuery = useQuery({ queryKey: ["bitrix-users"], queryFn: listBitrixUsers, enabled: connected, retry: false });
  const mapQuery = useQuery({ queryKey: ["bitrix-user-map"], queryFn: getUserMap });
  const outboxQuery = useQuery({ queryKey: ["bitrix-outbox"], queryFn: listOutbox, refetchInterval: 15000 });
  const dealMetaQuery = useQuery({ queryKey: ["bitrix-deal-meta"], queryFn: getDealMeta, enabled: connected, retry: false });
  const syncDeals = useMutation({
    mutationFn: syncDealsNow,
    onSuccess: (r) =>
      r.off
        ? message.warning("Сделки выключены или не выбрана воронка — сохраните настройки")
        : message.success(`Привязано ${r.linked ?? 0}, создано ${r.created ?? 0}, передвинуто стадий ${r.moved ?? 0}${r.errors ? `, ошибок ${r.errors}` : ""}`),
    onError: (e) => message.error(apiErrorMessage(e, "Не получилось")),
  });
  const [map, setMap] = useState<Record<number, number | null>>({});
  useEffect(() => {
    if (mapQuery.data) setMap(Object.fromEntries(mapQuery.data.map((r) => [r.user_id, r.bitrix_user_id])));
  }, [mapQuery.data]);

  const save = useMutation({
    mutationFn: () => saveBitrixSettings(s!),
    onSuccess: (v) => {
      setS(v);
      qc.invalidateQueries({ queryKey: ["bitrix-settings"] });
      qc.invalidateQueries({ queryKey: ["bitrix-chats"] });
      qc.invalidateQueries({ queryKey: ["bitrix-users"] });
      message.success("Настройки Битрикс24 сохранены");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить")),
  });
  const test = useMutation({
    mutationFn: (dialog: string | null) => testBitrix(dialog),
    onSuccess: (r, dialog) => message.success(dialog ? `Сообщение отправлено (вебхук: ${r.name})` : `Связь есть: вебхук от имени ${r.name}`),
    onError: (e) => message.error(apiErrorMessage(e, "Нет связи с Битрикс24")),
  });
  const saveMap = useMutation({
    mutationFn: () => saveUserMap(Object.entries(map).map(([k, v]) => ({ user_id: Number(k), bitrix_user_id: v }))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bitrix-user-map"] });
      message.success("Сотрудники сохранены");
    },
  });
  const retry = useMutation({ mutationFn: retryOutbox, onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ["bitrix-outbox"] }), 1500) });

  const chatOptions = (chatsQuery.data ?? []).map((c) => ({ value: c.dialog_id, label: c.title }));
  const userOptions = useMemo(
    () => (bxUsersQuery.data ?? []).map((u) => ({ value: u.id, label: u.email ? `${u.name} · ${u.email}` : u.name })),
    [bxUsersQuery.data],
  );
  // Подобрать по фамилии и имени: «Картамышева Ирина Геннадьевна» ↔ «Картамышева Ирина».
  const autoMatch = () => {
    const norm = (x: string) => x.toLowerCase().replace(/ё/g, "е").split(/\s+/).slice(0, 2).join(" ");
    const next = { ...map };
    for (const r of mapQuery.data ?? []) {
      if (next[r.user_id]) continue;
      const hit = (bxUsersQuery.data ?? []).find((u) => norm(u.name) === norm(r.full_name));
      if (hit) next[r.user_id] = hit.id;
    }
    setMap(next);
  };

  if (!s) return null;
  const set = (p: Partial<Settings>) => setS({ ...s, ...p });
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%", maxWidth: 980 }}>
      <Card size="small" title="Подключение">
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="Входящий вебхук создаёт администратор Битрикс24"
          description="Приложения → Разработчикам → Другое → Входящий вебхук. Права: Мессенджер (im), Задачи (task), CRM (crm), Пользователи (user), Бизнес-процессы (bizproc). Адрес вебхука — как пароль: вставьте его только сюда."
        />
        <Form layout="vertical">
          <Form.Item label="Адрес вебхука" extra={s.webhook_set ? "Сохранён. Чтобы заменить — вставьте новый." : "https://портал.bitrix24.ru/rest/1/код/"}>
            <Input.Password value={s.webhook ?? ""} onChange={(e) => set({ webhook: e.target.value })} placeholder="https://…bitrix24.ru/rest/…/…/" />
          </Form.Item>
          <Form.Item label="Адрес программы для ссылок в сообщениях">
            <Space.Compact style={{ width: "100%" }}>
              <Input value={s.base_url ?? ""} onChange={(e) => set({ base_url: e.target.value })} placeholder="https://…:8002" />
              <Button onClick={() => set({ base_url: window.location.origin })}>Этот адрес</Button>
            </Space.Compact>
          </Form.Item>
          <Space wrap>
            <Switch checked={s.enabled} onChange={(v) => set({ enabled: v })} />
            <span>Отправлять события в Битрикс24</span>
            <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Сохранить
            </Button>
            <Button disabled={!connected} loading={test.isPending && !test.variables} onClick={() => test.mutate(null)}>
              Проверить связь
            </Button>
          </Space>
        </Form>
      </Card>

      <Card size="small" title="Куда отправлять">
        {!connected ? (
          <Typography.Text type="secondary">Сначала сохраните адрес вебхука.</Typography.Text>
        ) : chatsQuery.isError ? (
          <Alert type="error" showIcon message={apiErrorMessage(chatsQuery.error, "Не удалось получить чаты")} />
        ) : (
          <Form layout="vertical">
            {(
              [
                ["chat_production", "Чат производства (новые заявки)", "ПРОИЗВОДСТВО | Межкомнатные"],
                ["chat_logistics", "Чат логистики (готово к отгрузке)", "ЛОГИСТИКА | Транспорт"],
                ["chat_purchasing", "Чат закупок (дефицит)", "ЗАКУПКИ | Склад"],
              ] as const
            ).map(([key, label, hint]) => (
              <Form.Item key={key} label={label} extra={`Например, «${hint}». Пользователь вебхука должен состоять в чате.`}>
                <Space.Compact style={{ width: "100%" }}>
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    loading={chatsQuery.isLoading}
                    options={chatOptions}
                    value={s[key] ?? undefined}
                    onChange={(v) => set({ [key]: v ?? null } as Partial<Settings>)}
                    style={{ width: "100%" }}
                  />
                  <Button disabled={!s[key]} onClick={() => test.mutate(s[key])}>
                    Тест
                  </Button>
                </Space.Compact>
              </Form.Item>
            ))}
            <Form.Item label="Кому ставить задачи на закупку" extra="Закупщик в Битрикс24">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                loading={bxUsersQuery.isLoading}
                options={userOptions}
                value={s.purchaser ?? undefined}
                onChange={(v) => set({ purchaser: v ?? null })}
              />
            </Form.Item>
            <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Сохранить
            </Button>
          </Form>
        )}
      </Card>

      <Card size="small" title="Сделки">
        {!connected ? (
          <Typography.Text type="secondary">Сначала сохраните адрес вебхука.</Typography.Text>
        ) : dealMetaQuery.isError ? (
          <Alert type="error" showIcon message={apiErrorMessage(dealMetaQuery.error, "Не удалось прочитать воронки — у вебхука есть право CRM?")} />
        ) : (
          <Form layout="vertical">
            <Typography.Paragraph type="secondary">
              При отправке заказа клиента производству программа ищет сделку, название которой начинается с номера счёта («2101-ЭЛ(М) щиты…»):
              одна — привязывает, ни одной — создаёт (если включено), несколько — ждёт выбора в карточке заказа. Дальше сама двигает сделку по
              стадиям — только вперёд и не из закрытых, — пишет обещанную отгрузку в поле даты и в ленту сделки: принятие, возврат, переносы,
              отмену. Проверка — раз в 20 минут.
            </Typography.Paragraph>
            <Space wrap style={{ marginBottom: 12 }}>
              <Switch checked={!!s.deals_enabled} onChange={(v) => set({ deals_enabled: v })} />
              <span>Вести сделки</span>
              <Switch checked={s.deal_auto_create !== false} onChange={(v) => set({ deal_auto_create: v })} />
              <span>Создавать сделку, если по счёту не нашлась</span>
            </Space>
            <Form.Item label="Воронка">
              <Select
                style={{ maxWidth: 420 }}
                loading={dealMetaQuery.isLoading}
                value={s.deal_category ?? undefined}
                onChange={(v) => set({ deal_category: v, deal_stage_accepted: null, deal_stage_production: null, deal_stage_ready: null, deal_stage_shipping: null })}
                options={(dealMetaQuery.data?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
              />
            </Form.Item>
            {(
              [
                ["deal_stage_accepted", "Заказ принят производством"],
                ["deal_stage_production", "В производстве"],
                ["deal_stage_ready", "Готов (на складе ГП)"],
                ["deal_stage_shipping", "Отгружается / отгружен"],
              ] as const
            ).map(([key, label]) => (
              <Form.Item key={key} label={`Стадия: ${label.toLowerCase()}`} style={{ marginBottom: 8 }}>
                <Select
                  allowClear
                  placeholder="не двигать"
                  style={{ maxWidth: 420 }}
                  value={s[key] ?? undefined}
                  onChange={(v) => set({ [key]: v ?? null } as Partial<Settings>)}
                  options={(dealMetaQuery.data?.categories.find((c) => c.id === s.deal_category)?.stages ?? []).map((st) => ({
                    value: st.id,
                    label: st.name,
                  }))}
                />
              </Form.Item>
            ))}
            <Form.Item label="Поле сделки для даты отгрузки">
              <Select
                allowClear
                placeholder="не заполнять"
                style={{ maxWidth: 420 }}
                value={s.deal_ship_field ?? undefined}
                onChange={(v) => set({ deal_ship_field: v ?? null })}
                options={(dealMetaQuery.data?.date_fields ?? []).map((f) => ({ value: f.id, label: f.name }))}
              />
            </Form.Item>
            <Space wrap>
              <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>
                Сохранить
              </Button>
              <Button loading={syncDeals.isPending} onClick={() => syncDeals.mutate()}>
                Проверить сделки сейчас
              </Button>
            </Space>
          </Form>
        )}
      </Card>

      <Card
        size="small"
        title="Сотрудники программы ↔ Битрикс24"
        extra={
          <Space>
            <Button disabled={!connected} onClick={autoMatch}>
              Подобрать по ФИО
            </Button>
            <Button type="primary" loading={saveMap.isPending} onClick={() => saveMap.mutate()}>
              Сохранить
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">Кому слать личные сообщения: менеджеру — о приёме, возврате и переносе его заявок.</Typography.Paragraph>
        <Table
          size="small"
          rowKey="user_id"
          pagination={false}
          dataSource={mapQuery.data ?? []}
          columns={[
            { title: "Сотрудник программы", dataIndex: "full_name" },
            {
              title: "Пользователь Битрикс24",
              render: (_, r) => (
                <Select
                  allowClear
                  showSearch
                  optionFilterProp="label"
                  style={{ width: 360 }}
                  disabled={!connected}
                  options={userOptions}
                  value={map[r.user_id] ?? undefined}
                  onChange={(v) => setMap({ ...map, [r.user_id]: v ?? null })}
                  placeholder={connected ? "не выбран" : "нет подключения"}
                />
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title="Журнал сообщений (последние 50)">
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={outboxQuery.data ?? []}
          locale={{ emptyText: "Сообщений пока не было" }}
          columns={[
            { title: "Когда", render: (_, r) => dayjs(r.created_at).format("DD.MM HH:mm") },
            { title: "Событие", render: (_, r) => EVENT_LABEL[r.event] ?? r.event },
            { title: "Текст", render: (_, r) => <Typography.Text style={{ fontSize: 12 }}>{r.text.replace(/\[\/?[A-Z]+[^\]]*\]/g, "")}</Typography.Text> },
            {
              title: "Статус",
              render: (_, r) =>
                r.status === "sent" ? (
                  <Tag color="green">отправлено</Tag>
                ) : r.status === "error" ? (
                  <Space direction="vertical" size={2}>
                    <Tag color="red">ошибка</Tag>
                    <Typography.Text type="danger" style={{ fontSize: 12 }}>{r.error}</Typography.Text>
                    <Button size="small" onClick={() => retry.mutate(r.id)}>Повторить</Button>
                  </Space>
                ) : (
                  <Tag>{r.status}</Tag>
                ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
