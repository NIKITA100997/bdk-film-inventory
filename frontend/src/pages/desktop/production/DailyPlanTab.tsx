import { useState } from "react";
import { Card, Space, Typography, DatePicker, Tag, Button, Empty } from "antd";
import dayjs from "dayjs";
import { useQuery } from "@tanstack/react-query";
import ResponsiveTable from "../../../components/ResponsiveTable";
import { listProductionTasks, type ProductionTaskLine } from "../../../api/production";
import { listAreas } from "../../../api/areas";
import { useAuth } from "../../../auth/AuthContext";
import ReportModal from "./ReportModal";
import MasterQuickReportPanel from "./MasterQuickReportPanel";

/** План на день (мастер) — суточный срез уже распределённых по линиям
 * строк заданий, с отчётом о браке прямо из строки. Раздел про
 * отключение распределения по дням (Area.requires_daily_plan=false,
 * пилот: окутка царговых) — для такого участка распределений никогда
 * не будет, эта таблица для него пуста и бессмысленна, поэтому вместо
 * неё показываем MasterQuickReportPanel (набор нужных позиций через
 * поиск + один общий отчёт вместо модалки на каждую строку). */
export default function DailyPlanTab() {
  const { user } = useAuth();
  const canReport =
    !!user?.is_superuser ||
    !!user?.permissions.includes("production_tasks.manage") ||
    !!user?.permissions.includes("production_tasks.report");
  const [selectedDate, setSelectedDate] = useState<dayjs.Dayjs>(dayjs());
  const [reportTarget, setReportTarget] = useState<
    { taskId: number; line: ProductionTaskLine; assignmentId: number; area: string } | null
  >(null);

  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaRequiresDailyPlan = (code: string) => areasQuery.data?.find((a) => a.code === code)?.requires_daily_plan ?? true;

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const tasks = (tasksQuery.data ?? []).filter((t) => (!user?.area || t.area === user.area) && t.is_active);

  if (user?.area && !areaRequiresDailyPlan(user.area)) {
    return <MasterQuickReportPanel area={user.area} />;
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
              { title: "Плёнка (номенклатура)", render: (_, r) => `${r.line.material}, ${r.line.color}, ${r.line.thickness} мм` },
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
          requiresRoll={reportTarget.area === "okutka_tsargovykh"}
          onClose={() => setReportTarget(null)}
        />
      )}
    </Space>
  );
}
