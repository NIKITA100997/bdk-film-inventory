import { useState } from "react";
import { Card, Space, Typography, DatePicker, Tag, Button, Empty, Select } from "antd";
import dayjs from "dayjs";
import { useQuery } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { lineFilmLabel, listProductionTasks, type ProductionTaskLine } from "../../../api/production";
import { areaRequiresRoll, listAreas } from "../../../api/areas";
import { useAuth } from "../../../auth/AuthContext";
import ReportModal from "./ReportModal";
import FastReportPanel from "./fastReport/FastReportPanel";
import { listPlanSlots } from "../../../api/planning";

/** План на день (мастер) — суточный срез уже распределённых по линиям
 * строк заданий, с отчётом о браке прямо из строки. Раздел про
 * отключение распределения по дням (Area.requires_daily_plan=false,
 * пилот: окутка царговых) — для такого участка распределений никогда
 * не будет, эта таблица для него пуста и бессмысленна, поэтому вместо
 * неё показываем быстрый отчёт FastReportPanel (плитки/таблица; прежняя
 * панель набора позиций — вид «Как раньше»).
 * Раздел про просмотр от лица админа/без своего участка — у реального
 * мастера участок закреплён на аккаунте (user.area), но администратор
 * обычно логинится без привязки к участку и иначе никогда не увидит
 * ни эту, ни новую панель — добавлен выбор участка (viewArea) именно
 * для такого случая. */
export default function DailyPlanTab() {
  const { user } = useAuth();
  const canReport =
    !!user?.is_superuser ||
    !!user?.permissions.includes("production_tasks.manage") ||
    !!user?.permissions.includes("production_tasks.report");
  const [selectedDate, setSelectedDate] = useState<dayjs.Dayjs>(dayjs());
  const [viewArea, setViewArea] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<
    { taskId: number; line: ProductionTaskLine; assignmentId: number; area: string } | null
  >(null);

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaRequiresDailyPlan = (code: string) => areasQuery.data?.find((a) => a.code === code)?.requires_daily_plan ?? true;
  // Мастер с закреплённым участком всегда видит только свой; у
  // администратора участок не закреплён — тогда используем то, что он
  // выбрал вручную (по умолчанию "Все участки", как и раньше).
  const effectiveArea = user?.area ?? viewArea;

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const tasks = (tasksQuery.data ?? []).filter((t) => (!effectiveArea || t.area === effectiveArea) && t.is_active);

  const areaPicker = !user?.area && (
    <Select
      allowClear
      placeholder="Все участки"
      style={{ width: 280 }}
      value={viewArea ?? undefined}
      onChange={(v) => setViewArea(v ?? null)}
      options={(areasQuery.data ?? []).map((a) => ({ value: a.code, label: a.name }))}
    />
  );

  if (effectiveArea && !areaRequiresDailyPlan(effectiveArea)) {
    return (
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        {areaPicker}
        <PlanForDay area={effectiveArea} canReport={canReport} />
        <FastReportPanel area={effectiveArea} allowLegacy />
      </Space>
    );
  }

  const dateStr = selectedDate.format("YYYY-MM-DD");

  const dailyItems = tasks.flatMap((task) =>
    task.lines.flatMap((line) => {
      const lineAssignments = line.assignments?.filter((a) => a.date === dateStr) ?? [];
      if (lineAssignments.length === 0) return [];
      return lineAssignments.map((a) => ({
        task,
        line,
        assignment: a,
      }));
    }),
  );

  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {areaPicker}
      {effectiveArea && <PlanForDay area={effectiveArea} canReport={canReport} />}
      <Card
        title={`📅 Суточный план участка на ${selectedDate.format("DD.MM.YYYY")}`}
        extra={
          <Space>
            <Typography.Text>Дата смены:</Typography.Text>
            <DatePicker value={selectedDate} onChange={(d) => d && setSelectedDate(d)} format="DD.MM.YYYY" allowClear={false} />
          </Space>
        }
      >
        {dailyItems.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`На ${selectedDate.format("DD.MM.YYYY")} нет запланированных задач по линиям`}
          />
        ) : (
          <ResponsiveTable
            tableKey="daily-plan"
            lockedColumns={["Модель / Задание"]}
            defaultHiddenColumns={["Деталь", "Плёнка (номенклатура)", "Штрипс", "Сотрудники линии"]}
            rowKey={(r) => `${r.line.id}-${r.assignment.id}`}
            dataSource={dailyItems}
            pagination={false}
            scroll={{ x: "max-content" }}
            columns={[
              { title: "Модель / Задание", render: (_, r) => r.task.product_model_name ?? r.task.name ?? `Задание №${r.task.id}` },
              { title: "Деталь", render: (_, r) => r.line.part_name ?? "—" },
              { title: "Линия", render: (_, r) => r.assignment.line_name },
              { title: "Плёнка (номенклатура)", render: (_, r) => lineFilmLabel(r.line) },
              { title: "Штрипс", render: (_, r) => `${r.line.strip_width_mm || r.line.width_mm} мм` },
              { title: "План на день", render: (_, r) => <Tag color="blue">{r.assignment.quantity_pieces} шт</Tag> },
              { title: "Сотрудники линии", render: (_, r) => r.assignment.employee_names },
              {
                title: "Хорошие/Брак за день",
                render: (_, r) => (
                  <Space size={4}>
                    <Tag color="green">{r.assignment.produced_good_pieces} шт</Tag>
                    {r.assignment.defect_pieces > 0 && <Tag color="red">брак {r.assignment.defect_pieces} шт</Tag>}
                  </Space>
                ),
              },
              // Раздел про цифровой аналог "Ежедневки" (пилот: окутка
              // царговых) — колонки бумажного бланка, отсутствуют ("—")
              // для остальных участков, где рулон при отчёте не выбирают.
              { title: "№ рулона", render: (_, r) => r.assignment.material_unit_id ?? "—" },
              {
                title: "Получено метров",
                render: (_, r) => (r.assignment.issued_length_m != null ? `${r.assignment.issued_length_m} м` : "—"),
              },
              {
                title: "Расход плёнки за день",
                render: (_, r) =>
                  r.assignment.material_unit_id != null
                    ? `${((r.assignment.produced_good_pieces + r.assignment.defect_pieces) * r.line.length_m).toFixed(2)} м`
                    : "—",
              },
              {
                title: "Остаток метров",
                render: (_, r) => (r.assignment.remaining_length_m != null ? `${r.assignment.remaining_length_m} м` : "—"),
              },
              {
                title: "Действия",
                render: (_, r) =>
                  canReport && (
                    <Button
                      size="small"
                      onClick={() =>
                        setReportTarget({ taskId: r.task.id, line: r.line, assignmentId: r.assignment.id, area: r.task.area })
                      }
                    >
                      Отчитаться
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </Card>

      {reportTarget && (
        <ReportModal
          taskId={reportTarget.taskId}
          line={reportTarget.line}
          presetAssignmentId={reportTarget.assignmentId}
          requiresRoll={areaRequiresRoll(areasQuery.data, reportTarget.area) && reportTarget.line.material !== null}
          area={reportTarget.area}
          onClose={() => setReportTarget(null)}
        />
      )}
    </Space>
  );
}

/** План участка на день из планировщика (сроки заказов): что сделать
 * сегодня, включая просроченное с прошлых дней, и отчёт прямо из строки. */
function PlanForDay({ area, canReport }: { area: string; canReport: boolean }) {
  const [day, setDay] = useState<dayjs.Dayjs>(dayjs());
  const [reportTarget, setReportTarget] = useState<{ taskId: number; line: ProductionTaskLine } | null>(null);
  const isToday = day.isSame(dayjs(), "day");
  const slotsQuery = useQuery({
    queryKey: ["plan-slots", area, day.format("YYYY-MM-DD"), "master"],
    queryFn: () =>
      listPlanSlots({ area, date_from: day.format("YYYY-MM-DD"), date_to: day.format("YYYY-MM-DD"), include_earlier: isToday }),
  });
  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const lineById = new Map((tasksQuery.data ?? []).flatMap((t) => t.lines.map((l) => [l.id, { task: t, line: l }] as const)));
  const rows = slotsQuery.data ?? [];
  return (
    <Card
      size="small"
      title={`🗓 По плану на ${day.format("DD.MM.YYYY")}${isToday ? " (с просроченным)" : ""}`}
      extra={<DatePicker value={day} onChange={(d) => d && setDay(d)} format="DD.MM.YYYY" allowClear={false} />}
    >
      {rows.length === 0 ? (
        <Typography.Text type="secondary">На этот день по планировщику ничего не стоит.</Typography.Text>
      ) : (
        <ResponsiveTable
          tableKey="plan-for-day"
          lockedColumns={["Что"]}
          rowKey={(r) => `${r.id}`}
          dataSource={rows}
          pagination={false}
          size="small"
          scroll={{ x: "max-content" }}
          columns={[
            {
              title: "Что",
              render: (_, r) => (
                <span>
                  {r.what}
                  {r.operation && <Typography.Text type="secondary"> · {r.operation}</Typography.Text>}
                  {r.overdue && <Tag color="red" style={{ marginLeft: 6 }}>просрочено</Tag>}
                </span>
              ),
            },
            { title: "Заказ", render: (_, r) => (r.order_id ? `№${r.order_id} «${r.order_name}»` : r.task_name) },
            { title: "План, шт", render: (_, r) => <b>{r.quantity}</b> },
            { title: "Сделано по строке", render: (_, r) => `${r.line_done} из ${r.line_plan}` },
            {
              title: "",
              render: (_, r) => {
                const hit = lineById.get(r.task_line_id);
                return (
                  canReport &&
                  hit && (
                    <Button size="small" type="primary" ghost onClick={() => setReportTarget({ taskId: hit.task.id, line: hit.line })}>
                      Отчитаться
                    </Button>
                  )
                );
              },
            },
          ]}
        />
      )}
      {reportTarget && (
        <ReportModal
          taskId={reportTarget.taskId}
          line={reportTarget.line}
          // Строка в плане на день — распределение по линиям не обязательно.
          requiresDailyPlan={false}
          requiresRoll={areaRequiresRoll(areasQuery.data, area) && reportTarget.line.material !== null}
          area={area}
          onClose={() => setReportTarget(null)}
        />
      )}
    </Card>
  );
}
