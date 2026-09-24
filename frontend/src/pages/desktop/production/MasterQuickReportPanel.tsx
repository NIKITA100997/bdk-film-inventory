import { useMemo, useRef, useState } from "react";
import { Card, Space, Typography, Select, InputNumber, Input, Button, message, Empty, Popconfirm, Modal, List, Tag, Form, Checkbox, Radio } from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { isAxiosError } from "axios";
import ResponsiveTable from "../../../components/ResponsiveTable";
import {
  lineFilmLabel,
  listProductionTasks,
  createTaskLineReportsBatch,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineReportCreate,
} from "../../../api/production";
import { listWriteOffReasons } from "../../../api/writeOffReasons";
import { listParts } from "../../../api/dictionaries";
import { listPartUnits } from "../../../api/partUnits";
import RollPicker, { type RollPickerOption } from "../../../components/RollPicker";

function apiErrorMessage(e: unknown, fallback: string): string {
  if (isAxiosError(e) && typeof e.response?.data?.detail === "string") return e.response.data.detail;
  return fallback;
}

interface DefectEntry {
  reason: string;
  qty: number;
  note?: string;
  // Раздел про переработку брака — по умолчанию "spisat" (списывается
  // насовсем, как раньше); "pererabotka" резервирует брак вместо
  // необратимого списания, забрать в готовую деталь можно позже
  // действием "Переработать в деталь" ("Учёт п/ф").
  disposition?: "spisat" | "pererabotka";
}

interface ReportRow {
  key: string;
  taskId: number;
  line: ProductionTaskLine;
  materialUnitId: number | null;
  goodPieces: number;
  // Раздел про несколько причин брака в одном отчёте — раньше был один
  // defectPieces + одна defectReason на всю строку, хотя по факту разные
  // штуки брака в одной партии часто идут по разным причинам (мусор под
  // плёнкой, царапина, скол и т.п.). Список записей вместо одной пары —
  // тот же приём, что уже есть в ReportModal.tsx (defectRows).
  defects: DefectEntry[];
  // Раздел про второй (третий...) рулон на ту же строку — двусторонние
  // детали часто расходуют НЕСКОЛЬКО разных рулонов одновременно на ОДИН
  // и тот же комплект деталей (не на разные штуки — деталь физически
  // одна, просто по стороне на каждый рулон), поэтому нельзя посчитать
  // "сколько деталей именно из него": это те же самые деталей, что и
  // указаны в goodPieces выше. remainingM — известный остаток именно на
  // ЭТОМ рулоне ПРЯМО СЕЙЧАС, м (то, что видно на самом рулоне) — при
  // сохранении по нему подбирается такой good_pieces, чтобы расчётный
  // остаток рулона (_unit_consumed_length_m) совпал с этим числом;
  // отчёт отправляется с counts_toward_line=false, чтобы не задвоить
  // план строки (эти же деталей уже засчитаны основным отчётом).
  // remainingM=0 — рулон израсходован полностью.
  extraRolls: { materialUnitId: number; remainingM: number }[];
  // Раздел про то, что «нулевой отчёт» больше нельзя занести молча —
  // когда по строке 0 хороших и 0 брака (деталь ещё не готова), но
  // рулон уже трогали, мастер вводит фактический остаток ЭТОГО рулона,
  // м. Пусто = не трогали (расход 0). При сохранении из этого числа
  // считается расход основного рулона (counts_toward_line=false).
  primaryRemainingM?: number;
}

const totalDefect = (row: ReportRow) => row.defects.reduce((sum, d) => sum + d.qty, 0);

/** Быстрый отчёт мастера без распределения по дням (участок с
 * Area.requires_daily_plan=false, пилот: окутка царговых) — раньше
 * приходилось открывать отдельную модалку "Отчитаться о производстве"
 * на КАЖДОЙ строке задания по одной (неудобно при десятке позиций за
 * смену). Здесь одним поиском набирается сразу список нужных позиций,
 * заполняется инлайн в таблице и сохраняется всё одним нажатием — один
 * отчёт по всем позициям, а не N отдельных модалок.
 *
 * Раздел про поиск позиции на планшете — раньше строкой ввода служил
 * обычный antd Select(showSearch): выпадающий список позиционируется
 * относительно поля через портал, и в горизонтальной ориентации (где и
 * так мало высоты) экранная клавиатура выталкивала список наполовину за
 * пределы видимой области. Модалка с обычным текстовым полем + плоским
 * List ниже не зависит от такого позиционирования — оба всегда в одном
 * скролл-контейнере модалки, клавиатура может занять сколько угодно
 * места снизу, список просто ужмётся, но останется на экране целиком. */
export default function MasterQuickReportPanel({ area }: { area: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const requiresRoll = area === "okutka_tsargovykh";
  // Рулон — только у строки с плёнкой (строка-операция без плёнки его не требует).
  const rowRequiresRoll = (r: ReportRow) => requiresRoll && r.line.material !== null;
  // Раздел про связь этапов с участками — «Партия п/ф» показывается для
  // ЛЮБОГО участка, у которого есть хоть один этап детали (не только у
  // окутки царговых): «Рулон» — отдельная, чисто плёночная забота.
  const partsQuery = useQuery({ queryKey: ["dict-autocomplete", "parts"], queryFn: listParts });
  const hasPartStages = (partsQuery.data ?? []).some((p) => p.stages.some((s) => s.area === area));
  // Раздел про недостающую видимость остатка п/ф прямо в отчёте —
  // реальный случай: мастер 8 раз подряд пытался сохранить "532 хороших",
  // хотя партий п/ф на участке физически было только 512 — экран об этом
  // никак не предупреждал, отчёт просто падал с ошибкой FIFO на сервере.
  // Тот же приём агрегации, что и в PartStock.tsx ("Остатки п/ф").
  const partUnitsQuery = useQuery({
    queryKey: ["part-units", "area", area],
    queryFn: () => listPartUnits({ area, status_: "Выдан_участку" }),
    enabled: hasPartStages,
  });
  const availableByPartId = useMemo(() => {
    const map = new Map<number, number>();
    for (const u of partUnitsQuery.data ?? []) map.set(u.part_id, (map.get(u.part_id) ?? 0) + u.quantity_available);
    return map;
  }, [partUnitsQuery.data]);
  const partIdByName = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of partsQuery.data ?? []) map.set(p.name, p.id);
    return map;
  }, [partsQuery.data]);
  const availableForLine = (line: ProductionTaskLine): number | null => {
    if (!line.part_name) return null;
    const partId = partIdByName.get(line.part_name);
    if (partId == null) return null;
    return availableByPartId.get(partId) ?? 0;
  };
  const [rows, setRows] = useState<ReportRow[]>([]);
  const rowCounter = useRef(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSearch, setPickerSearch] = useState("");
  const [defectRowKey, setDefectRowKey] = useState<string | null>(null);
  const [defectForm] = Form.useForm<{ reason: string; qty: number; note?: string; disposition?: "spisat" | "pererabotka" }>();

  const tasksQuery = useQuery({ queryKey: ["production-tasks"], queryFn: listProductionTasks });
  const writeOffReasonsQuery = useQuery({ queryKey: ["write-off-reasons", "production"], queryFn: () => listWriteOffReasons("production") });
  // Раздел про физический учёт деталей — причина брака та же, что
  // списывает и партию п/ф, пикер объединяет обе категории причин.
  const partsReasonsQuery = useQuery({
    queryKey: ["write-off-reasons", "parts"],
    queryFn: () => listWriteOffReasons("parts"),
    enabled: hasPartStages,
  });
  const reasonOptions = [...(writeOffReasonsQuery.data ?? []), ...(partsReasonsQuery.data ?? [])].filter(
    (r, i, arr) => arr.findIndex((x) => x.code === r.code) === i,
  );
  const reasonName = (code: string) => reasonOptions.find((r) => r.code === code)?.name ?? code;

  const tasks = (tasksQuery.data ?? []).filter((t: ProductionTask) => t.area === area && t.is_active);
  const addedLineIds = useMemo(() => new Set(rows.map((r) => r.line.id)), [rows]);

  // production_closed — раздел про явное завершение работы по строке в
  // производстве (независимо от is_closed/выдачи): закрытая строка
  // больше не предлагается для новых отчётов, пока её явно не
  // возобновят («Учёт заданий»).
  const positionOptions = tasks.flatMap((task) =>
    task.lines
      .filter((line) => !line.production_closed)
      .map((line) => ({
        key: `${task.id}:${line.id}`,
        taskId: task.id,
        line,
        label: `${task.product_model_name ?? task.name ?? `Задание №${task.id}`} — ${line.part_name ?? line.material} (${line.material}, ${line.color}, ${line.thickness} мм) — осталось ${line.remaining_pieces} шт`,
        added: addedLineIds.has(line.id),
      })),
  );
  const filteredPositionOptions = pickerSearch.trim()
    ? positionOptions.filter((o) => o.label.toLowerCase().includes(pickerSearch.trim().toLowerCase()))
    : positionOptions;

  // presetRollId — раздел про общий штрипс на детали одного задания:
  // строка добавляется по подсказке (уже выбранный рулон подходит и ей
  // по ширине, см. suggestedLines ниже), а не через обычный поиск
  // позиции — тогда рулон подставляется сразу, не как единственно
  // возможный автовыбор по issued_units.
  const addRow = (taskId: number, line: ProductionTaskLine, presetRollId?: number) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    rowCounter.current += 1;
    const key = `${line.id}-${rowCounter.current}`;
    // Раздел про защиту от повторного добавления — проверка внутри
    // функционального updater'а (не по внешнему addedLineIds) видит
    // самое свежее состояние rows на момент реального применения, а не
    // на момент рендера, где был вызван addRow: два быстрых клика по
    // одной и той же позиции (двойной тап на подсказке соседних строк
    // или на поиске позиции) иначе создавали две строки на одну и ту же
    // деталь — производство по ней задваивалось в отчёте.
    setRows((prev) => {
      if (prev.some((r) => r.line.id === line.id)) return prev;
      return [
        ...prev,
        {
          key,
          taskId: task.id,
          line,
          materialUnitId: presetRollId ?? (line.issued_units.length === 1 ? line.issued_units[0].id : null),
          goodPieces: 0,
          defects: [],
          extraRolls: [],
        },
      ];
    });
    setPickerOpen(false);
    setPickerSearch("");
  };

  const updateRow = (key: string, patch: Partial<ReportRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));

  // Раздел про общий штрипс на детали одного задания — как только в одной
  // строке отчёта выбран рулон (свой или заимствованный), ищем в ТОМ ЖЕ
  // задании другие ещё не добавленные строки такой же ширины штрипса и
  // предлагаем сразу добавить их с этим же рулоном, не заставляя мастера
  // искать их заново через "Добавить позицию…". Один рулон может закрыть
  // сразу несколько строк — sepen следит, чтобы одна и та же строка не
  // попала в подсказку дважды, даже если её ширина совпала с рулонами из
  // нескольких разных строк отчёта.
  const suggestedLines = useMemo(() => {
    const suggestions: { line: ProductionTaskLine; taskId: number; rollUnitId: number }[] = [];
    const seen = new Set<number>();
    for (const r of rows) {
      const pickedRollIds = [r.materialUnitId, ...r.extraRolls.map((e) => e.materialUnitId)].filter(
        (id): id is number => id != null,
      );
      if (pickedRollIds.length === 0) continue;
      const task = tasks.find((t) => t.id === r.taskId);
      if (!task) continue;
      const stripWidth = r.line.strip_width_mm || r.line.width_mm;
      for (const sibling of task.lines) {
        if (sibling.id === r.line.id) continue;
        if (sibling.production_closed) continue;
        if (sibling.remaining_pieces <= 0) continue;
        if (addedLineIds.has(sibling.id) || seen.has(sibling.id)) continue;
        if ((sibling.strip_width_mm || sibling.width_mm) !== stripWidth) continue;
        seen.add(sibling.id);
        suggestions.push({ line: sibling, taskId: task.id, rollUnitId: pickedRollIds[0] });
      }
    }
    return suggestions;
  }, [rows, tasks, addedLineIds]);
  // Отмечены по умолчанию все — suggestionUnchecked хранит только явные
  // исключения (тот же приём, что "показывать архивные" и т.п. в других
  // местах проекта: множество отклонений компактнее множества согласий).
  const [suggestionUnchecked, setSuggestionUnchecked] = useState<Set<number>>(new Set());
  const checkedSuggestions = suggestedLines.filter((s) => !suggestionUnchecked.has(s.line.id));

  const addDefectEntry = (key: string, entry: DefectEntry) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, defects: [...r.defects, entry] } : r)));
  const removeDefectEntry = (key: string, index: number) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, defects: r.defects.filter((_, i) => i !== index) } : r)));

  // Раздел про сбой формы отчёта (несколько независимых запросов одним
  // Promise.all на один клик "Сохранить" — если один падал уже ПОСЛЕ
  // того, как другие успели закоммититься по отдельности, форма не
  // отслеживала частичный успех: повторный клик пересылал ВСЕ вызовы
  // заново, задваивая уже прошедшие. Реальный случай — брак 15 шт
  // списался 8 раз как 120, потому что 7 из 8 попыток были именно такими
  // повторами). Теперь — один batch-запрос НА СТРОКУ (все её payload'ы:
  // основной good_pieces + причины брака + доп. рулоны) одной транзакцией
  // на бэкенде (create_task_line_reports_batch): либо коммитится вся
  // строка целиком, либо ничего — повторный клик безопасен. Строки
  // между собой (Promise.allSettled) независимы: если упала одна из
  // десяти позиций, остальные девять всё равно сохранятся, а в форме
  // останется только упавшая — со внятной причиной вместо общей фразы.
  const saveMutation = useMutation({
    mutationFn: async () => {
      const settled = await Promise.allSettled(
        rows.map(async (r) => {
          const payloads: ProductionTaskLineReportCreate[] = [];
          if (r.goodPieces > 0) {
            // Раздел про учёт п/ф по FIFO — партия для готовых деталей
            // больше не передаётся: бэкенд сам расходует от самой старой
            // (по дате изготовления), part_unit_id здесь не нужен.
            payloads.push({
              assignment_id: null,
              material_unit_id: r.materialUnitId,
              good_pieces: r.goodPieces,
              defect_pieces: 0,
            });
          }
          for (const d of r.defects) {
            payloads.push({
              assignment_id: null,
              material_unit_id: r.materialUnitId,
              good_pieces: 0,
              defect_pieces: d.qty,
              defect_reason: d.reason,
              defect_disposition: d.disposition,
              note: d.note,
            });
          }
          // Раздел про расход плёнки без готовой детали (окутка в 2 захода) —
          // ни одной хорошей детали, ни брака ещё нет (деталь физически не
          // готова), но рулон уже трогали. Раньше слался "нулевой" отчёт
          // (good=0/defect=0) — рулон навсегда выглядел нетронутым. Теперь
          // мастер вводит фактический остаток этого рулона: расход
          // считается из (было − остаток), отчёт с counts_toward_line=false
          // (сам факт использования всё так же фиксируется — рулон можно
          // вернуть/списать, see has_report в return_unit). Пустой остаток =
          // не трогали → good_pieces 0, как раньше.
          if (rowRequiresRoll(r) && r.goodPieces <= 0 && r.defects.length === 0 && r.materialUnitId) {
            const pu = r.line.issued_units.find((u) => u.id === r.materialUnitId) ??
              (r.line.borrowable_units ?? []).find((u) => u.id === r.materialUnitId);
            const puRemaining = pu?.remaining_length_m ?? pu?.length_m ?? 0;
            const target = r.primaryRemainingM ?? puRemaining;
            const consumedNeeded = Math.max(0, puRemaining - target);
            const gp = r.line.length_m > 0 ? consumedNeeded / r.line.length_m : 0;
            payloads.push({
              assignment_id: null,
              material_unit_id: r.materialUnitId,
              good_pieces: gp,
              defect_pieces: 0,
              counts_toward_line: false,
              note:
                r.primaryRemainingM != null
                  ? `Остаток указан вручную: ${r.primaryRemainingM} м`
                  : "Рулон использован, деталь ещё не готова",
            });
          }
          // Раздел про второй рулон на ту же строку (двусторонние детали) —
          // это те же самые деталей, что и в goodPieces выше, просто ещё
          // один рулон физически тоже участвовал (другая сторона), поэтому
          // "сколько деталей именно из него" не считаем — вместо этого
          // подбираем good_pieces под указанный вручную остаток ЭТОГО
          // рулона и шлём отдельным отчётом с counts_toward_line=false,
          // чтобы не задвоить план строки (эти деталей уже учтены основным
          // отчётом выше).
          for (const extra of r.extraRolls) {
            const unit =
              r.line.issued_units.find((u) => u.id === extra.materialUnitId) ??
              (r.line.borrowable_units ?? []).find((u) => u.id === extra.materialUnitId);
            const currentRemaining = unit?.remaining_length_m ?? unit?.length_m ?? 0;
            const consumedNeeded = Math.max(0, currentRemaining - extra.remainingM);
            const goodPiecesEquivalent = r.line.length_m > 0 ? consumedNeeded / r.line.length_m : 0;
            payloads.push({
              assignment_id: null,
              material_unit_id: extra.materialUnitId,
              good_pieces: goodPiecesEquivalent,
              defect_pieces: 0,
              counts_toward_line: false,
              note: `Остаток указан вручную: ${extra.remainingM} м`,
            });
          }
          if (payloads.length > 0) await createTaskLineReportsBatch(r.taskId, r.line.id, payloads);
          return r.key;
        }),
      );
      return settled;
    },
    onSuccess: (settled) => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      const succeededKeys = new Set(
        settled.filter((s): s is PromiseFulfilledResult<string> => s.status === "fulfilled").map((s) => s.value),
      );
      const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
      if (failures.length === 0) {
        message.success(`Отчёт по ${rows.length} ${rows.length === 1 ? "позиции" : "позициям"} сохранён`);
        setRows([]);
      } else {
        // Раздел про частичный успех — упавшие строки остаются в форме
        // для повтора (без риска задвоить уже сохранённые), успевшие
        // сохраниться убираются сразу.
        setRows((prev) => prev.filter((r) => !succeededKeys.has(r.key)));
        message.error(
          `Сохранено ${succeededKeys.size} из ${rows.length}. Ошибка: ${apiErrorMessage(failures[0].reason, "не удалось сохранить часть позиций")}`,
        );
      }
    },
    onError: () => message.error("Не удалось сохранить отчёт"),
  });

  const handleSave = () => {
    if (rows.length === 0) {
      message.warning("Добавьте хотя бы одну позицию");
      return;
    }
    for (const r of rows) {
      // Раздел про расход плёнки без готовой детали — 0 хороших и 0 брака
      // допустимо ТОЛЬКО на участке с выбором рулона (requiresRoll) и
      // только если рулон реально выбран — тогда это осознанный отчёт
      // "рулон использован, деталь не готова", а не пустая строка,
      // которую забыли заполнить.
      const isMaterialOnlyReport = rowRequiresRoll(r) && r.goodPieces <= 0 && totalDefect(r) <= 0 && !!r.materialUnitId;
      if (r.goodPieces <= 0 && totalDefect(r) <= 0 && !isMaterialOnlyReport) {
        message.warning(`Укажите хорошие детали или брак по строке «${r.line.part_name ?? r.line.material}»`);
        return;
      }
      if (rowRequiresRoll(r) && !r.materialUnitId) {
        message.warning(`Выберите рулон по строке «${r.line.part_name ?? r.line.material}»`);
        return;
      }
    }
    saveMutation.mutate();
  };

  const defectRow = rows.find((r) => r.key === defectRowKey) ?? null;

  return (
    <Card title="📋 Отчёт о производстве">
      <Typography.Paragraph type="secondary">
        Найдите нужные детали через поиск ниже — каждая добавится отдельной строкой в отчёт. Заполните количество и
        сохраните всё одним нажатием.
        {hasPartStages && (
          <>
            {" "}Партия п/ф не выбирается вручную ни для готовых деталей, ни для брака — списывается автоматически от
            самой старой по дате изготовления («Учёт п/ф»).
          </>
        )}
        {requiresRoll && (
          <>
            {" "}Если деталь окутывается в несколько заходов и сегодня не готова целиком (например, сделана только
            одна сторона) — можно сохранить строку с 0 хороших и 0 брака, просто отметив рулон: это зафиксирует
            расход плёнки и позволит вернуть/списать рулон, не дожидаясь готовой детали. Если деталь двусторонняя и
            на неё одновременно расходуется НЕСКОЛЬКО рулонов (по одному на сторону — это те же самые детали, не
            дополнительные) — отметьте галочкой каждый и укажите для доп. рулонов фактический остаток в метрах
            прямо сейчас (0 — рулон израсходован полностью). Рулон, отмеченный для одной строки, автоматически
            предлагается и соседним строкам этого же задания с такой же шириной штрипса.
          </>
        )}
      </Typography.Paragraph>
      <Button block size="large" onClick={() => setPickerOpen(true)}>
        🔍 Добавить позицию…
      </Button>

      <Modal
        title="Найти позицию"
        open={pickerOpen}
        onCancel={() => {
          setPickerOpen(false);
          setPickerSearch("");
        }}
        footer={null}
        destroyOnHidden
      >
        <Input.Search
          autoFocus
          allowClear
          placeholder="Название детали или задания…"
          value={pickerSearch}
          onChange={(e) => setPickerSearch(e.target.value)}
          style={{ marginBottom: 12 }}
        />
        {tasksQuery.isLoading ? (
          <Typography.Text type="secondary">Загрузка…</Typography.Text>
        ) : filteredPositionOptions.length === 0 ? (
          <Typography.Text type="secondary">
            {positionOptions.length === 0 ? "Нет активных заданий для вашего участка" : "Ничего не найдено"}
          </Typography.Text>
        ) : (
          <List
            style={{ maxHeight: "50vh", overflowY: "auto" }}
            dataSource={filteredPositionOptions}
            renderItem={(o) => (
              <List.Item
                onClick={() => !o.added && addRow(o.taskId, o.line)}
                style={{ cursor: o.added ? "default" : "pointer", opacity: o.added ? 0.55 : 1 }}
              >
                <List.Item.Meta title={o.label} description={o.added ? "✓ уже добавлено" : undefined} />
              </List.Item>
            )}
          />
        )}
      </Modal>

      {rows.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Пока ни одна позиция не добавлена" style={{ marginTop: 16 }} />
      ) : (
        <>
          <ResponsiveTable<ReportRow>
            tableKey="master-quick-report"
            lockedColumns={["remove"]}
            rowKey="key"
            size="small"
            pagination={false}
            dataSource={rows}
            scroll={{ x: "max-content" }}
            style={{ marginTop: 16, marginBottom: 16 }}
            columns={[
              {
                title: "Деталь",
                key: "part",
                render: (_, r) => {
                  const available = availableForLine(r.line);
                  return (
                    <Space direction="vertical" size={0}>
                      <Typography.Text strong>{r.line.part_name ?? r.line.material}</Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {lineFilmLabel(r.line)} — произведено {r.line.produced_good_pieces} из{" "}
                        {r.line.quantity_pieces} шт
                      </Typography.Text>
                      {available != null && (
                        <Space size={4}>
                          <Tag
                            color={available < r.goodPieces + totalDefect(r) ? "orange" : "default"}
                            style={{ margin: 0, fontSize: 11 }}
                          >
                            доступно партий п/ф: {Math.round(available * 100) / 100} шт
                          </Tag>
                          <a
                            style={{ fontSize: 11 }}
                            onClick={() => {
                              const partId = r.line.part_name ? partIdByName.get(r.line.part_name) : undefined;
                              if (partId != null) navigate("/part-card", { state: { partId } });
                            }}
                          >
                            Остатки п/ф →
                          </a>
                        </Space>
                      )}
                    </Space>
                  );
                },
              },
              ...(requiresRoll
                ? [
                    {
                      title: "Рулон(ы)",
                      key: "roll",
                      render: (_: unknown, r: ReportRow) => {
                        if (r.line.material === null) return <Typography.Text type="secondary">без плёнки</Typography.Text>;
                        // Раздел про второй рулон на ту же строку — двусторонние
                        // детали нередко расходуют одновременно НЕСКОЛЬКО
                        // разных рулонов на ОДИН и тот же комплект деталей
                        // (разные стороны), поэтому "сколько деталей именно
                        // из него" не спрашиваем — только остаток в метрах,
                        // видимый прямо на самом рулоне. Раздел про общий
                        // штрипс на детали одного задания — к своим выданным
                        // рулонам добавляем рулоны соседних строк того же
                        // задания с такой же шириной штрипса (borrowable_units),
                        // помечая, с какой детали. RollPicker — единый список
                        // с галочками вместо раздельных "Рулон"/"+ ещё рулон".
                        const rollPickerOptions: RollPickerOption[] = [
                          ...r.line.issued_units.map((u) => ({ value: u.id, widthMm: u.width_mm, remainingM: u.remaining_length_m ?? u.length_m, own: true })),
                          ...(r.line.borrowable_units ?? []).map((u) => ({
                            value: u.id,
                            widthMm: u.width_mm,
                            remainingM: u.remaining_length_m ?? u.length_m,
                            own: false,
                            fromPartName: u.from_part_name,
                          })),
                        ];
                        return (
                          <Space direction="vertical" size={4}>
                            <RollPicker
                              options={rollPickerOptions}
                              value={r.materialUnitId}
                              onChange={(v) => updateRow(r.key, { materialUnitId: v })}
                              extraRolls={r.extraRolls}
                              onExtraRollsChange={(rolls) => updateRow(r.key, { extraRolls: rolls })}
                            />
                            {r.goodPieces <= 0 && r.defects.length === 0 && r.materialUnitId != null && (
                              <Space size={4}>
                                <InputNumber
                                  size="small"
                                  min={0}
                                  style={{ width: 80 }}
                                  value={r.primaryRemainingM}
                                  placeholder="остаток"
                                  onChange={(v) => updateRow(r.key, { primaryRemainingM: v ?? undefined })}
                                />
                                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                                  м остаток (деталь не готова)
                                </Typography.Text>
                              </Space>
                            )}
                          </Space>
                        );
                      },
                    },
                  ]
                : []),
              {
                title: "Хорошие, шт",
                key: "good",
                render: (_, r) => {
                  // Раздел про общий штрипс на детали одного задания — если
                  // выбран рулон (свой или заимствованный) и введённых
                  // деталей на него не хватает по метражу, мягко
                  // предупреждаем; сабмит не блокируем — мастер решает.
                  const selUnit =
                    r.materialUnitId == null
                      ? undefined
                      : r.line.issued_units.find((u) => u.id === r.materialUnitId) ??
                        (r.line.borrowable_units ?? []).find((u) => u.id === r.materialUnitId);
                  const remain = selUnit?.remaining_length_m ?? selUnit?.length_m;
                  const needM = r.goodPieces * r.line.length_m;
                  const short = remain != null && needM > remain;
                  return (
                    <Space direction="vertical" size={2}>
                      <InputNumber size="small" min={0} style={{ width: 90 }} value={r.goodPieces} onChange={(v) => updateRow(r.key, { goodPieces: v ?? 0 })} />
                      {short && (
                        <Typography.Text type="warning" style={{ fontSize: 11 }}>
                          нужно ~{needM.toFixed(1)} м, на рулоне {remain} м
                        </Typography.Text>
                      )}
                    </Space>
                  );
                },
              },
              {
                title: "Брак",
                key: "defect",
                render: (_, r) => (
                  <Space direction="vertical" size={4}>
                    {r.defects.map((d, i) => (
                      <Tag key={i} closable onClose={() => removeDefectEntry(r.key, i)} style={{ marginRight: 0 }}>
                        {reasonName(d.reason)}: {d.qty} шт{d.disposition === "pererabotka" && " ♻️"}
                      </Tag>
                    ))}
                    <Button
                      size="small"
                      onClick={() => {
                        // Раздел про несколько причин брака — форма одна на все
                        // строки (defectForm), не размонтируется между открытиями
                        // (destroyOnHidden чистит только DOM модалки, не сам
                        // Form.useForm store) — без явного сброса недописанный
                        // черновик причины по одной строке подставлялся бы при
                        // открытии для другой.
                        defectForm.resetFields();
                        setDefectRowKey(r.key);
                      }}
                    >
                      {r.defects.length > 0 ? `+ ещё причина (всего ${totalDefect(r)} шт)` : "+ указать брак"}
                    </Button>
                  </Space>
                ),
              },
              {
                title: "",
                key: "remove",
                render: (_, r) => (
                  <Popconfirm title="Убрать эту позицию из отчёта?" onConfirm={() => removeRow(r.key)}>
                    <Button size="small" danger>
                      Убрать
                    </Button>
                  </Popconfirm>
                ),
              },
            ]}
          />

          {suggestedLines.length > 0 && (
            <Card size="small" style={{ marginBottom: 16, background: "#e6f7f9", borderColor: "#8dd3dc" }}>
              <Space direction="vertical" style={{ width: "100%" }}>
                <Typography.Text>
                  💡 Уже выбранный рулон подходит по ширине ещё этим строкам того же задания:
                </Typography.Text>
                <Space direction="vertical" size={4}>
                  {suggestedLines.map((s) => (
                    <Checkbox
                      key={s.line.id}
                      checked={!suggestionUnchecked.has(s.line.id)}
                      onChange={(e) =>
                        setSuggestionUnchecked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.delete(s.line.id);
                          else next.add(s.line.id);
                          return next;
                        })
                      }
                    >
                      {s.line.part_name ?? s.line.material} — нужно ещё {s.line.remaining_pieces} шт
                    </Checkbox>
                  ))}
                </Space>
                <Button
                  type="primary"
                  size="small"
                  disabled={checkedSuggestions.length === 0}
                  onClick={() => checkedSuggestions.forEach((s) => addRow(s.taskId, s.line, s.rollUnitId))}
                >
                  Добавить отмеченные{checkedSuggestions.length > 0 ? ` (${checkedSuggestions.length})` : ""}
                </Button>
              </Space>
            </Card>
          )}

          <Button type="primary" block loading={saveMutation.isPending} onClick={handleSave}>
            Сохранить отчёт ({rows.length} {rows.length === 1 ? "позиция" : "позиций"})
          </Button>
        </>
      )}

      <Modal
        title={`Брак — «${defectRow?.line.part_name ?? defectRow?.line.material ?? ""}»`}
        open={!!defectRow}
        onCancel={() => setDefectRowKey(null)}
        footer={null}
        destroyOnHidden
      >
        {defectRow && (
          <>
            {defectRow.defects.length > 0 && (
              <Space direction="vertical" style={{ width: "100%", marginBottom: 16 }}>
                {defectRow.defects.map((d, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <span>
                      {reasonName(d.reason)}: <strong>{d.qty} шт</strong>
                      {d.disposition === "pererabotka" && <Tag color="blue" style={{ marginLeft: 4 }}>♻️ в переработку</Tag>}
                      {d.note && <Typography.Text type="secondary"> — {d.note}</Typography.Text>}
                    </span>
                    <Button size="small" danger onClick={() => removeDefectEntry(defectRow.key, i)}>
                      Убрать
                    </Button>
                  </div>
                ))}
              </Space>
            )}
            <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
              Брак может быть по нескольким причинам сразу — например, 1 деталь мусор под плёнкой, 2 деталь царапины:
              добавьте отдельную запись на каждую причину.
            </Typography.Paragraph>
            <Form
              form={defectForm}
              layout="vertical"
              initialValues={{ disposition: "spisat" }}
              onFinish={(v) => {
                addDefectEntry(defectRow.key, { reason: v.reason, qty: v.qty, note: v.note, disposition: v.disposition });
                defectForm.resetFields();
              }}
            >
              <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
                <Select
                  loading={writeOffReasonsQuery.isLoading || partsReasonsQuery.isLoading}
                  options={reasonOptions.map((r) => ({ value: r.code, label: r.name }))}
                />
              </Form.Item>
              <Form.Item name="qty" label="Количество, шт" rules={[{ required: true }]}>
                <InputNumber min={1} style={{ width: "100%" }} />
              </Form.Item>
              {hasPartStages && (
                <Form.Item
                  name="disposition"
                  label="Что с браком"
                  extra="«В переработку» резервирует материал (не списывает насовсем) — из него потом можно сделать партию другой детали («Учёт п/ф» → «Переработать в деталь»)."
                >
                  <Radio.Group
                    options={[
                      { label: "Списать насовсем", value: "spisat" },
                      { label: "♻️ В переработку", value: "pererabotka" },
                    ]}
                    optionType="button"
                  />
                </Form.Item>
              )}
              <Form.Item name="note" label="Заметка (опционально)">
                <Input placeholder="Например: мусор под плёнкой" />
              </Form.Item>
              <Button htmlType="submit" block>
                Добавить причину
              </Button>
            </Form>
            <Button block type="primary" style={{ marginTop: 16 }} onClick={() => setDefectRowKey(null)}>
              Готово
            </Button>
          </>
        )}
      </Modal>
    </Card>
  );
}
