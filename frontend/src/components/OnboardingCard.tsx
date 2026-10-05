import { Button, Card, Space, Typography } from "antd";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { CurrentUser } from "../auth/types";
import { markOnboardingSeen } from "../utils/onboarding";

interface HelpBlock {
  test: (u: CurrentUser) => boolean;
  title: string;
  body: string;
  action?: { label: string; path: string };
}

// Порядок = приоритет показа (раздел 16 бэклога доработок — онбординг по
// правам, не по названию роли: роли теперь произвольные, создаются в
// админке "Роли и права", жёстко привязываться к системным кодам нельзя).
const HELP_BLOCKS: HelpBlock[] = [
  {
    test: (u) => u.permissions.includes("units.receive"),
    title: "Приёмка партии",
    body: "«Склад → Приёмка плёнки» — заполните рулон и нажмите «Добавить и дальше», ячейка подбирается автоматически. После приёмки — печать этикеток одной кнопкой.",
    action: { label: "Открыть приёмку", path: "/m/receive" },
  },
  {
    test: (u) => u.permissions.includes("units.issue"),
    title: "Выдача участку",
    body: "«Склад → Выдача участку» — потребности по заданиям подставляются автоматически, донор на разрезку подбирается сам.",
    action: { label: "Открыть выдачу", path: "/m/issue" },
  },
  {
    test: (u) =>
      (u.permissions.includes("units.cut") || u.permissions.includes("units.return")) &&
      !u.permissions.includes("units.receive") &&
      !u.permissions.includes("units.issue"),
    title: "Раскрой и возврат остатка",
    body: "Отдельного пункта меню для этого нет — раскрой и возврат открываются через карточку конкретной единицы: сканом QR-кода на рулоне/штрипсе или кликом по строке в «Остатках».",
  },
  {
    test: (u) => u.permissions.includes("production_tasks.manage") || u.permissions.includes("production_tasks.view"),
    title: "Задания цеха",
    body: "«Производство → Задания цеха» — вкладка «Мой участок» для мастера смены, «Задания» — список заданий с отборами и карточкой задания.",
    action: { label: "Открыть задания", path: "/production-tasks" },
  },
  {
    test: (u) => u.permissions.includes("production_tasks.manage"),
    title: "Заказы и запуск",
    body: "«Производство → Заказы на производство» — новый заказ (вручную или из графика) сохраняется черновиком. На его странице выбираются п/ф со склада, площадки ламинации и сроки, видно, что получит каждый участок; «Запустить заказ» создаёт задания участкам.",
    action: { label: "Открыть заказы", path: "/production-orders" },
  },
  {
    test: (u) => u.permissions.includes("part_units.manage") || u.permissions.includes("part_units.view"),
    title: "Детали п/ф",
    body: "«Склад → Остатки», вид «П/ф» — остатки и партии деталей; «Производство → Потребность → П/ф» — сколько деталей не хватает под задания. Партию открывает скан QR-кода на наклейке.",
    action: { label: "Открыть остатки п/ф", path: "/stock?kind=pf" },
  },
  {
    test: (u) => u.permissions.includes("purchasing.manage"),
    title: "Закупки плёнки",
    body: "«Закупки → Закупки плёнки» — заявки поставщику, привязка к приёмке при закрытии.",
    action: { label: "Открыть закупки", path: "/purchasing" },
  },
  {
    test: (u) => u.permissions.includes("sales_calculator.view"),
    title: "Калькулятор заказа",
    body: "«Продажи и заказы → Калькулятор заказа» — расход плёнки на заказ из нескольких дверей и цветов (с погонажом), остаток/резерв по складу и подсказки аналогов из неликвида.",
    action: { label: "Открыть калькулятор", path: "/sales-calculator" },
  },
  {
    test: (u) => u.permissions.includes("users.manage"),
    title: "Пользователи, роли и участки",
    body: "«Администрирование» — пользователи, роли и права, заявки на удаление, настройки. Участки — «Производство → Участки и линии».",
    action: { label: "Открыть администрирование", path: "/users" },
  },
];

const MAX_ROLE_BLOCKS = 3;

interface Props {
  onClose: () => void;
}

/** Приветственная карточка на "Обзоре" (раздел 16 бэклога доработок —
 * онбординг нового сотрудника). Не модалка — не блокирует работу, можно
 * скрыть и продолжать; повторно открывается через пункт меню пользователя
 * (AppLayout.tsx). Содержимое — по правам пользователя (Overview.tsx уже
 * строит карточки-сигналы тем же способом), не по названию роли. */
export default function OnboardingCard({ onClose }: Props) {
  const { user } = useAuth();
  const navigate = useNavigate();
  if (!user) return null;

  const matchedBlocks = user.is_superuser ? HELP_BLOCKS : HELP_BLOCKS.filter((b) => b.test(user));
  const roleBlocks = matchedBlocks.slice(0, MAX_ROLE_BLOCKS);

  const hide = () => {
    markOnboardingSeen(user.id);
    onClose();
  };

  return (
    <Card title="Добро пожаловать — с чего начать" style={{ marginBottom: 16 }}>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {roleBlocks.map((b) => (
          <div key={b.title}>
            <Typography.Text strong>{b.title}</Typography.Text>
            <Typography.Paragraph style={{ marginBottom: b.action ? 4 : 0 }}>{b.body}</Typography.Paragraph>
            {b.action && (
              <Button size="small" onClick={() => navigate(b.action!.path)}>
                {b.action.label}
              </Button>
            )}
          </div>
        ))}
        <div>
          <Typography.Text strong>Поиск и сканирование</Typography.Text>
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            Лупа в шапке — поиск по ID единицы или названию материала с любого экрана. Кнопка QR рядом — сразу
            открывает карточку отсканированной единицы.
          </Typography.Paragraph>
        </div>
        <Button onClick={hide}>Понятно, скрыть</Button>
      </Space>
    </Card>
  );
}
