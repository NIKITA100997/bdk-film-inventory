import { Modal, Form, Select, DatePicker, InputNumber, Button, Table, Typography, message } from "antd";
import dayjs from "dayjs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listProductionLines,
  listTaskLineAssignments,
  createTaskLineAssignment,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineAssignmentCreate,
} from "../../../api/production";
import EmployeesTagSelect from "../../../components/EmployeesTagSelect";

/** Распределение строки задания по линиям/дням/сотрудникам (раздел 12.5)
 * — отдельный экран начальника участка поверх уже созданного задания.
 * Вынесено в свой компонент (раздел 16 бэклога доработок — ProductionTasks.tsx
 * разросся до 889 строк одним модалкой-на-модалке), самодостаточен: сам
 * тянет линии участка и историю распределений по своим query-ключам. */
export default function AssignmentModal({
  task,
  line,
  onClose,
}: {
  task: ProductionTask;
  line: ProductionTaskLine;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [assignForm] = Form.useForm<{ line_id: number; date: dayjs.Dayjs; employee_names: string; quantity_pieces: number }>();

  const linesQuery = useQuery({ queryKey: ["production-lines"], queryFn: listProductionLines });
  const linesForTask = (linesQuery.data ?? []).filter((l) => l.is_active && l.area === task.area);

  const assignmentsQuery = useQuery({
    queryKey: ["task-line-assignments", task.id, line.id],
    queryFn: () => listTaskLineAssignments(task.id, line.id),
  });
  const assignedSoFar = (assignmentsQuery.data ?? []).reduce((sum, a) => sum + a.quantity_pieces, 0);

  const assignMutation = useMutation({
    mutationFn: (v: ProductionTaskLineAssignmentCreate) => createTaskLineAssignment(task.id, line.id, v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      qc.invalidateQueries({ queryKey: ["task-line-assignments", task.id, line.id] });
      assignForm.resetFields();
      message.success("Распределение сохранено");
    },
    onError: () => message.error("Не удалось сохранить распределение"),
  });

  return (
    <Modal title={`Распределение строки «${line.part_name ?? line.material}»`} open onCancel={onClose} footer={null} destroyOnHidden>
      <Typography.Paragraph type="secondary">
        Нужно всего: {line.quantity_pieces} шт. Распределено по линиям: <Typography.Text strong>{assignedSoFar}</Typography.Text> из{" "}
        {line.quantity_pieces} шт.
      </Typography.Paragraph>

      <Table
        rowKey="id"
        size="small"
        loading={assignmentsQuery.isLoading}
        dataSource={assignmentsQuery.data ?? []}
        pagination={false}
        locale={{ emptyText: "Пока не распределено ни по одной линии" }}
        style={{ marginBottom: 16 }}
        scroll={{ x: "max-content" }}
        columns={[
          { title: "Линия", dataIndex: "line_name" },
          { title: "Дата", render: (_, a) => dayjs(a.date).format("DD.MM.YYYY") },
          { title: "Сотрудники", dataIndex: "employee_names" },
          { title: "Кол-во, шт", dataIndex: "quantity_pieces" },
        ]}
      />

      <Typography.Title level={5}>Добавить распределение</Typography.Title>
      <Form layout="vertical" form={assignForm} onFinish={(v) => assignMutation.mutate({ ...v, date: v.date.format("YYYY-MM-DD") })}>
        <Form.Item name="line_id" label="Линия" rules={[{ required: true }]}>
          <Select options={linesForTask.map((l) => ({ value: l.id, label: l.name }))} />
        </Form.Item>
        <Form.Item name="date" label="Дата" rules={[{ required: true }]} initialValue={dayjs()}>
          <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
        </Form.Item>
        <Form.Item name="employee_names" label="Сотрудники" rules={[{ required: true }]}>
          <EmployeesTagSelect placeholder="Иванов, Петров" />
        </Form.Item>
        <Form.Item name="quantity_pieces" label="Количество, шт" rules={[{ required: true }]}>
          <InputNumber min={1} style={{ width: "100%" }} />
        </Form.Item>
        <Button type="primary" htmlType="submit" block loading={assignMutation.isPending}>
          Добавить
        </Button>
      </Form>
    </Modal>
  );
}
