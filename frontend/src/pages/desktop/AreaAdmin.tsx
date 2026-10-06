import { useState } from "react";
import { InputNumber, Card, Tag, Button, Modal, Form, Input, Select, Space, Typography, Checkbox, message } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listAreas, createArea, updateArea, type Area } from "../../api/areas";
import { listSites, createSite, updateSite, type Site } from "../../api/sites";
import { listWarehouses } from "../../api/storage";
import ResponsiveTable from "../../components/ResponsiveTable";
import { apiErrorMessage } from "../../utils/apiError";

/** Участки (раздел про адаптацию под планшет — "администрирование
 * участков, какие есть и т.п.") — раньше жёсткий enum, теперь создаваемая
 * администратором сущность, тот же паттерн, что "Роли и права": название
 * редактируется, код (стабильный идентификатор в базе) выводится сервером
 * из названия и не меняется.
 *
 * Площадки (раздел про площадки, 2026-08-28) — у компании физически две
 * площадки (Северный/Фабрика), каждая с ровно одним домашним складом;
 * участок опционально привязан к площадке, чтобы при выдаче плёнки можно
 * было предупредить, если она физически лежит не на "своём" складе (см.
 * Issue.tsx). Площадки администрируются на этой же странице, тем же
 * паттерном CRUD, что и сами участки. */
export default function AreaAdmin() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<{ name: string; site_id?: number; requires_daily_plan?: boolean; requires_roll_on_report?: boolean }>();
  const [editing, setEditing] = useState<Area | null>(null);
  const [editForm] = Form.useForm<{
    name: string;
    site_id?: number;
    requires_daily_plan?: boolean;
    requires_roll_on_report?: boolean;
    film_cut_on_site?: boolean;
    lead_days?: number;
    capacity_per_shift?: number | null;
    shifts_per_day?: number;
    film_allowance_mm?: number | null;
    big_batch_area?: string;
    big_batch_min_pieces?: number | null;
    close_without_reports?: boolean;
    film_no_return?: boolean;
    pay_mode?: "piece" | "shift" | null;
    piece_rate?: number | null;
    shift_rate?: number | null;
    shift_headcount?: number | null;
  }>();
  const [showArchived, setShowArchived] = useState(false);

  const [siteCreateOpen, setSiteCreateOpen] = useState(false);
  const [siteCreateForm] = Form.useForm<{ name: string; warehouse_id: number }>();
  const [editingSite, setEditingSite] = useState<Site | null>(null);
  const [siteEditForm] = Form.useForm<{ name: string; warehouse_id: number; is_fg_main?: boolean }>();

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: listSites });
  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });

  const siteLabel = (siteId: number | null) => (sitesQuery.data ?? []).find((s) => s.id === siteId)?.name ?? "—";
  const warehouseLabel = (warehouseId: number) => (warehousesQuery.data ?? []).find((w) => w.id === warehouseId)?.name ?? "—";

  const createMutation = useMutation({
    mutationFn: (v: { name: string; site_id?: number; requires_daily_plan?: boolean; requires_roll_on_report?: boolean }) =>
      createArea(v.name, v.site_id, v.requires_daily_plan, v.requires_roll_on_report),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["areas"] });
      setCreateOpen(false);
      createForm.resetFields();
      message.success("Участок создан");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать участок")),
  });

  const archiveMutation = useMutation({
    mutationFn: ({ code, is_active }: { code: string; is_active: boolean }) => updateArea(code, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["areas"] });
      message.success("Сохранено");
    },
  });

  const editMutation = useMutation({
    mutationFn: (v: {
      name: string;
      site_id?: number;
      requires_daily_plan?: boolean;
      requires_roll_on_report?: boolean;
      film_cut_on_site?: boolean;
      lead_days?: number;
      capacity_per_shift?: number | null;
      shifts_per_day?: number;
      film_allowance_mm?: number | null;
      big_batch_area?: string | null;
      big_batch_min_pieces?: number | null;
      close_without_reports?: boolean;
      film_no_return?: boolean;
      pay_mode?: "piece" | "shift" | null;
      piece_rate?: number | null;
      shift_rate?: number | null;
      shift_headcount?: number | null;
    }) =>
      updateArea(editing!.code, {
        // пусто — снять настройку (0 / "" на сервере — «не задано»)
        film_allowance_mm: v.film_allowance_mm ?? 0,
        big_batch_area: v.big_batch_area ?? "",
        big_batch_min_pieces: v.big_batch_min_pieces ?? 0,
        close_without_reports: v.close_without_reports,
        film_no_return: v.film_no_return,
        // пусто — снять (на сервере "" / 0 — «не задано»)
        pay_mode: v.pay_mode ?? "",
        piece_rate: v.piece_rate ?? 0,
        shift_rate: v.shift_rate ?? 0,
        shift_headcount: v.shift_headcount ?? 0,
        lead_days: v.lead_days,
        // пусто — снять мощность (0 на сервере — «не задана»)
        capacity_per_shift: v.capacity_per_shift ?? 0,
        shifts_per_day: v.shifts_per_day,
        name: v.name,
        site_id: v.site_id ?? null,
        requires_daily_plan: v.requires_daily_plan,
        requires_roll_on_report: v.requires_roll_on_report,
        film_cut_on_site: v.film_cut_on_site,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["areas"] });
      setEditing(null);
      message.success("Сохранено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить участок")),
  });

  const createSiteMutation = useMutation({
    mutationFn: (v: { name: string; warehouse_id: number }) => createSite(v.name, v.warehouse_id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sites"] });
      setSiteCreateOpen(false);
      siteCreateForm.resetFields();
      message.success("Площадка создана");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось создать площадку")),
  });

  const editSiteMutation = useMutation({
    mutationFn: (v: { name: string; warehouse_id: number; is_fg_main?: boolean }) => updateSite(editingSite!.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sites"] });
      setEditingSite(null);
      message.success("Сохранено");
    },
    onError: (e) => message.error(apiErrorMessage(e, "Не удалось сохранить площадку")),
  });

  const archiveSiteMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) => updateSite(id, { is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sites"] });
      message.success("Сохранено");
    },
  });

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      <Card
        title="Площадки"
        extra={
          <Button type="primary" onClick={() => setSiteCreateOpen(true)}>
            Добавить площадку
          </Button>
        }
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Физическая площадка (Северный/Фабрика) — у каждой ровно один домашний склад. Участки ниже привязываются к
          площадке, чтобы на «Выдаче» можно было предупредить, если плёнка физически лежит не на своём складе.
        </Typography.Paragraph>
        <ResponsiveTable<Site>
          tableKey="sites"
          lockedColumns={["Название"]}
          rowKey="id"
          loading={sitesQuery.isLoading}
          dataSource={sitesQuery.data ?? []}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name" },
            { title: "Домашний склад", render: (_, s) => warehouseLabel(s.warehouse_id) },
            {
              title: "Готовая продукция",
              render: (_, s) => (s.is_fg_main ? <Tag color="blue">основной склад</Tag> : <Typography.Text type="secondary">перевалка</Typography.Text>),
            },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (v: boolean) => (v ? <Tag color="green">Активна</Tag> : <Tag>В архиве</Tag>),
            },
            {
              title: "",
              render: (_, s) => (
                <Space>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditingSite(s);
                      siteEditForm.setFieldsValue({ name: s.name, warehouse_id: s.warehouse_id, is_fg_main: s.is_fg_main });
                    }}
                  >
                    Изменить
                  </Button>
                  <Button size="small" onClick={() => archiveSiteMutation.mutate({ id: s.id, is_active: !s.is_active })}>
                    {s.is_active ? "В архив" : "Восстановить"}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="Участки"
        extra={
          <Space>
            <Checkbox checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)}>
              Показывать архивные
            </Checkbox>
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              Добавить участок
            </Button>
          </Space>
        }
      >
        <ResponsiveTable<Area>
          tableKey="areas"
          lockedColumns={["Название"]}
          rowKey="code"
          loading={areasQuery.isLoading}
          dataSource={(areasQuery.data ?? []).filter((a) => showArchived || a.is_active)}
          pagination={false}
          scroll={{ x: "max-content" }}
          columns={[
            { title: "Название", dataIndex: "name" },
            { title: "Код", dataIndex: "code", render: (v: string) => <Typography.Text type="secondary">{v}</Typography.Text> },
            { title: "Площадка", render: (_, a) => siteLabel(a.site_id) },
            {
              title: "Планирование",
              dataIndex: "requires_daily_plan",
              render: (v: boolean) => (v ? <Tag color="blue">По дням</Tag> : <Tag>Просто на участок</Tag>),
            },
            {
              title: "Срок операции",
              render: (_, a) => `${a.lead_days} раб. дн.`,
            },
            {
              title: "Мощность",
              render: (_, a) =>
                a.capacity_per_shift ? (
                  `${a.capacity_per_shift} шт × ${a.shifts_per_day} см.`
                ) : (
                  <Typography.Text type="secondary">не задана</Typography.Text>
                ),
            },
            {
              title: "Рулон в отчёте",
              dataIndex: "requires_roll_on_report",
              render: (v: boolean, a: Area) => (
                <Space size={4} wrap>
                  {v ? <Tag color="orange">Обязателен</Tag> : <Typography.Text type="secondary">—</Typography.Text>}
                  {a.film_cut_on_site && <Tag color="blue">режут на участке</Tag>}
                  {!!a.film_allowance_mm && <Tag>припуск +{a.film_allowance_mm} мм</Tag>}
                  {a.close_without_reports && <Tag color="default">без отчётов — закрытие целиком</Tag>}
                  {a.film_no_return && <Tag color="default">остатки плёнки не возвращают</Tag>}
                  {a.pay_mode === "piece" && <Tag color="green">сдельно{a.piece_rate ? ` ${a.piece_rate} ₽/шт` : ""}</Tag>}
                  {a.pay_mode === "shift" && (
                    <Tag color="green">
                      за смену{a.shift_rate ? ` ${a.shift_rate} ₽ × ${a.shift_headcount ?? "?"} чел.` : ""}
                    </Tag>
                  )}
                  {a.big_batch_area && (
                    <Tag color="purple">
                      от {a.big_batch_min_pieces} шт →{" "}
                      {(areasQuery.data ?? []).find((x) => x.code === a.big_batch_area)?.name ?? a.big_batch_area}
                    </Tag>
                  )}
                </Space>
              ),
            },
            {
              title: "Статус",
              dataIndex: "is_active",
              render: (v: boolean) => (v ? <Tag color="green">Активен</Tag> : <Tag>В архиве</Tag>),
            },
            {
              title: "",
              render: (_, a) => (
                <Space>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditing(a);
                      editForm.setFieldsValue({
                        name: a.name,
                        site_id: a.site_id ?? undefined,
                        requires_daily_plan: a.requires_daily_plan,
                        requires_roll_on_report: a.requires_roll_on_report,
                        film_cut_on_site: a.film_cut_on_site,
                        lead_days: a.lead_days,
                        capacity_per_shift: a.capacity_per_shift,
                        shifts_per_day: a.shifts_per_day,
                        film_allowance_mm: a.film_allowance_mm,
                        big_batch_area: a.big_batch_area ?? undefined,
                        big_batch_min_pieces: a.big_batch_min_pieces,
                        close_without_reports: a.close_without_reports,
                        film_no_return: a.film_no_return,
                        pay_mode: a.pay_mode,
                        piece_rate: a.piece_rate,
                        shift_rate: a.shift_rate,
                        shift_headcount: a.shift_headcount,
                      });
                    }}
                  >
                    Изменить
                  </Button>
                  <Button size="small" onClick={() => archiveMutation.mutate({ code: a.code, is_active: !a.is_active })}>
                    {a.is_active ? "В архив" : "Восстановить"}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal title="Новый участок" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null} destroyOnHidden>
        <Form
          form={createForm}
          layout="vertical"
          initialValues={{ requires_daily_plan: true }}
          onFinish={(v) => createMutation.mutate(v)}
        >
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus placeholder="Раскрой ПВХ" />
          </Form.Item>
          <Form.Item name="site_id" label="Площадка (опционально)">
            <Select
              allowClear
              loading={sitesQuery.isLoading}
              options={(sitesQuery.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
          <Form.Item name="requires_daily_plan" valuePropName="checked">
            <Checkbox>Разбивка по дням/бригадам (мастер распределяет через «План на день»)</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Если выключить — задания участка планируются просто на участок, без «Распределить»/«План на день»,
            и на выдаче не помечаются как «не распределено».
          </Typography.Paragraph>
          <Form.Item name="requires_roll_on_report" valuePropName="checked">
            <Checkbox>Рулон обязателен в отчёте о производстве</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Отчёт по строке с плёнкой — только с указанием рулона, а рулон нельзя вернуть без отчёта (как на окутке
            царговых). Строк без плёнки не касается.
          </Typography.Paragraph>
          <Button type="primary" htmlType="submit" block loading={createMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal title={`Изменить «${editing?.name ?? ""}»`} open={!!editing} onCancel={() => setEditing(null)} footer={null} destroyOnHidden>
        <Form form={editForm} layout="vertical" onFinish={(v) => editMutation.mutate(v)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="site_id" label="Площадка (опционально)">
            <Select
              allowClear
              loading={sitesQuery.isLoading}
              options={(sitesQuery.data ?? []).map((s) => ({ value: s.id, label: s.name }))}
            />
          </Form.Item>
          <Form.Item name="requires_daily_plan" valuePropName="checked">
            <Checkbox>Разбивка по дням/бригадам (мастер распределяет через «План на день»)</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Если выключить — задания участка планируются просто на участок, без «Распределить»/«План на день»,
            и на выдаче не помечаются как «не распределено».
          </Typography.Paragraph>
          <Form.Item name="requires_roll_on_report" valuePropName="checked">
            <Checkbox>Рулон обязателен в отчёте о производстве</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Отчёт по строке с плёнкой — только с указанием рулона, а рулон нельзя вернуть без отчёта (как на окутке
            царговых). Строк без плёнки не касается.
          </Typography.Paragraph>
          <Form.Item name="film_cut_on_site" valuePropName="checked">
            <Checkbox>Плёнку режут на участке (выдаётся рулон целиком)</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Как на мембранно-вакуумных прессах: склад не режет штрипсы, а выдаёт рулон любой ширины; отчёт списывает
            метры по норме (длина детали на штуку), фактический расход уточняется при возврате остатка.
          </Typography.Paragraph>
          <Form.Item name="pay_mode" label="Оплата работ (для себестоимости)">
            <Select
              allowClear
              placeholder="не задана — работа в себестоимость не входит"
              options={[
                { value: "piece", label: "Сдельно — за годную штуку" },
                { value: "shift", label: "За смену" },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(a, b) => a.pay_mode !== b.pay_mode}>
            {({ getFieldValue }) =>
              getFieldValue("pay_mode") === "piece" ? (
                <Form.Item
                  name="piece_rate"
                  label="Расценка по умолчанию, ₽ за штуку"
                  extra="Своя расценка операции (формулой в «Типах и правилах» или в маршруте позиции) — важнее этой."
                >
                  <InputNumber min={0} step={0.5} style={{ width: 160 }} />
                </Form.Item>
              ) : getFieldValue("pay_mode") === "shift" ? (
                <Space size={12} wrap>
                  <Form.Item name="shift_rate" label="Ставка смены на человека, ₽">
                    <InputNumber min={0} step={100} style={{ width: 160 }} />
                  </Form.Item>
                  <Form.Item name="shift_headcount" label="Людей в смене" extra="Считается за каждый день с выпуском × смен в день">
                    <InputNumber min={0} step={1} style={{ width: 120 }} />
                  </Form.Item>
                </Space>
              ) : null
            }
          </Form.Item>
          <Form.Item name="close_without_reports" valuePropName="checked">
            <Checkbox>По строкам не отчитываются — задание закрывают целиком</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Как на Фабрике: мастер не вносит отчёты, плёнка списывается метражом; когда сделано — «Закрыть: всё
            сделано», строки засчитываются, задание уходит в архив.
          </Typography.Paragraph>
          <Form.Item name="film_no_return" valuePropName="checked">
            <Checkbox>Остатки плёнки на склад не возвращаются</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Рулоны и штрипсы расходуют до конца. В «Выдаче» вместо «Принять ПЛ-…» — «ПЛ-… израсходован»: рулон
            списывается до нуля как расход, не брак; возврата от участка не ждём.
          </Typography.Paragraph>
          <Form.Item
            name="film_allowance_mm"
            label="Припуск плёнки к ширине детали, мм"
            extra="Штрипс под деталь без своей ширины штрипса = ширина детали + припуск (широкоформатная окутка на Фабрике — 7 мм). Пусто — в ширину детали."
          >
            <InputNumber min={0} max={200} style={{ width: 160 }} placeholder="без припуска" />
          </Form.Item>
          <Space size={12} wrap align="start">
            <Form.Item name="big_batch_area" label="Крупные партии — предлагать на участок">
              <Select
                allowClear
                style={{ width: 280 }}
                placeholder="не предлагать"
                options={(areasQuery.data ?? [])
                  .filter((x) => x.is_active && x.code !== editing?.code)
                  .map((x) => ({ value: x.code, label: x.name }))}
              />
            </Form.Item>
            <Form.Item name="big_batch_min_pieces" label="от, шт">
              <InputNumber min={0} style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Для операций с плёнкой: при запуске партия от этого количества предлагается на другой участок (ламинация
            панелей от 200 шт — окутка на Фабрике), выбор можно поменять.
          </Typography.Paragraph>
          <Form.Item
            name="lead_days"
            label="Срок операции, рабочих дней"
            extra="Планирование: на столько рабочих дней раньше ставится предыдущая операция заказа при расчёте сроков назад от отгрузки."
          >
            <InputNumber min={0} max={30} style={{ width: 160 }} />
          </Form.Item>
          <Space size={12} wrap>
            <Form.Item name="capacity_per_shift" label="Мощность, шт в смену">
              <InputNumber min={0} style={{ width: 160 }} placeholder="не задана" />
            </Form.Item>
            <Form.Item name="shifts_per_day" label="Смен в день">
              <InputNumber min={1} max={4} style={{ width: 120 }} />
            </Form.Item>
          </Space>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8, fontSize: 12.5 }}>
            Пока для планировщика: загрузка дня против мощности, перегруз подсвечивается. Сроки заказов мощность пока не
            учитывают.
          </Typography.Paragraph>
          <Button type="primary" htmlType="submit" block loading={editMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>

      <Modal title="Новая площадка" open={siteCreateOpen} onCancel={() => setSiteCreateOpen(false)} footer={null} destroyOnHidden>
        <Form form={siteCreateForm} layout="vertical" onFinish={(v) => createSiteMutation.mutate(v)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus placeholder="Северный" />
          </Form.Item>
          <Form.Item name="warehouse_id" label="Домашний склад" rules={[{ required: true }]}>
            <Select
              loading={warehousesQuery.isLoading}
              options={(warehousesQuery.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
            />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={createSiteMutation.isPending}>
            Создать
          </Button>
        </Form>
      </Modal>

      <Modal
        title={`Изменить «${editingSite?.name ?? ""}»`}
        open={!!editingSite}
        onCancel={() => setEditingSite(null)}
        footer={null}
        destroyOnHidden
      >
        <Form form={siteEditForm} layout="vertical" onFinish={(v) => editSiteMutation.mutate(v)}>
          <Form.Item name="name" label="Название" rules={[{ required: true }]}>
            <Input autoFocus />
          </Form.Item>
          <Form.Item name="warehouse_id" label="Домашний склад" rules={[{ required: true }]}>
            <Select
              loading={warehousesQuery.isLoading}
              options={(warehousesQuery.data ?? []).map((w) => ({ value: w.id, label: w.name }))}
            />
          </Form.Item>
          <Form.Item name="is_fg_main" valuePropName="checked" extra="Сюда в итоге везут готовые двери; с других площадок их перемещают («Остатки → Изделия»). Основной склад — один.">
            <Checkbox>Основной склад готовой продукции</Checkbox>
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={editSiteMutation.isPending}>
            Сохранить
          </Button>
        </Form>
      </Modal>
    </Space>
  );
}
