import { useEffect, useMemo, useState } from "react";
import {
  Form,
  Modal,
  Tag,
  message,
} from "antd";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import dayjs, { type Dayjs } from "dayjs";
import { toOccurredAtIso } from "../../../utils/occurredAt";
import { printReport } from "../../../utils/printReport";
import {
  issueUnit,
  issueUnitDirect,
  placeUnit,
  searchUnits,
  executeCuttingRecipe,
  type AreaValue,
  type CuttingRecipeResponse,
  type DonorSuggestion,
  type IssueResult,
  type MaterialSku,
  type MaterialUnit,
} from "../../../api/units";
import { suggestLocation } from "../../../api/storage";
import { listMaterialSkus } from "../../../api/dictionaries";
import { createShopFloorPurchaseRequest, type PurchaseRequestShopFloorCreate } from "../../../api/purchasing";
import { listAreas } from "../../../api/areas";
import { listSites } from "../../../api/sites";
import { listWarehouses } from "../../../api/storage";
import {
  listProductionTasks,
  closeTaskLine,
  type ProductionTask,
  type ProductionTaskLine,
  type ProductionTaskLineIssuedUnit,
} from "../../../api/production";
import { type CuttingFormInitialWidthCut } from "../../../components/CuttingForm";
import { useAuth } from "../../../auth/AuthContext";
import { listWidthAnalogGroups, isWidthMatch } from "../../../api/widthAnalogs";
import { rollNo } from "../../../utils/lotNo";
import { issueErrorMessage, type CuttingBatchEntry, type StockDecision, type RowStatus, type RowInfo, type StatusFilterValue, type NeedTableRow, type ManualTableRow, type TableRow, findSku, type IssuePrefill, type QueueSelection, type QueueRowData, neededLengthM, groupQueueRows, type IssuedResult } from "./model";


/** Вся логика экрана «Выдача участку» (06.10: вынесена из Issue.tsx без
 * изменений) — состояния, запросы, действия. Разметка — в компонентах
 * issue/*, они получают результат хука целиком. */
export function useIssue() {
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const canReturn = !!user?.is_superuser || !!user?.permissions.includes("units.return");
  // Раздел про мастера участка на этом же экране — у него есть units.return
  // (принимать возврат своего участка), но не units.issue: без этого флага
  // кнопки "Выдать"/"Разрезать и выдать"/подбор донора и т.п. были видны и
  // кликабельны всем, кто вообще попал на экран (видимость пункта меню —
  // units.issue ИЛИ units.return), а по клику падал сырой 403 с бэкенда
  // (require_permission("units.issue")) — мастер не поймёт эту ошибку, ему
  // только принимать возврат здесь и нужно (см. banner "Готово к возврату").
  const canIssue = !!user?.is_superuser || !!user?.permissions.includes("units.issue");
  // Раздел про замену плёнки на выдаче — той же номенклатуры может не быть
  // в наличии, точный аналог по цвету/толщине оператор решает подобрать
  // сам вместо заявки на закупку; сервер запомнит расхождение в строке
  // задания только при наличии этого права (units.py::_validate_matches_
  // task_line), иначе как раньше — жёсткий отказ.
  const canOverrideMaterial = !!user?.is_superuser || !!user?.permissions.includes("production_tasks.manage");
  // Раздел про закрытие строки задания по выдаче — то же право, что и
  // override материала выше (управленческое решение, не рутинная выдача
  // складом); отдельное имя здесь только для ясности у места вызова.
  const canManage = canOverrideMaterial;
  const prefill = (location.state as IssuePrefill | null) ?? undefined;

  const [selected, setSelected] = useState<QueueSelection | null>(null);
  // Раздел про замену плёнки на выдаче — SKU, выбранный оператором вместо
  // того, что требует строка задания.
  const [substituteSkuId, setSubstituteSkuId] = useState<number | undefined>(undefined);
  const [areaFilter, setAreaFilter] = useState<AreaValue | undefined>(undefined);
  // Раздел про фильтр по заданию — очередь по умолчанию показывает сразу
  // все активные задания вперемешку (только по участку/тексту можно было
  // сузить); выбор конкретного задания даёт тот же список, только на одно
  // задание, вместо поиска его строк среди остальных вручную.
  const [taskFilter, setTaskFilter] = useState<number | undefined>(undefined);
  // Раздел про фильтр по статусу — та же категория, что показывает пилюля
  // в колонке «Статус»/иконка в «Действиях», просто вынесенная в
  // отдельный выбор сверху, чтобы не листать все строки в поиске одного
  // конкретного состояния (например, только «нет донора» на смену).
  const [statusFilter, setStatusFilter] = useState<StatusFilterValue | undefined>(undefined);
  const [search, setSearch] = useState("");
  // Вид очереди: карточки (планшет) или таблица (компьютер); запоминается на устройстве.
  const [queueView, setQueueView] = useState<"cards" | "table">(() => {
    try {
      const saved = localStorage.getItem("issue-view");
      if (saved === "cards" || saved === "table") return saved;
    } catch {
      /* нет хранилища */
    }
    return typeof window !== "undefined" && window.innerWidth < 992 ? "cards" : "table";
  });
  const pickQueueView = (v: "cards" | "table") => {
    setQueueView(v);
    try {
      localStorage.setItem("issue-view", v);
    } catch {
      /* не запоминаем */
    }
  };
  const [cardTab, setCardTab] = useState<"need" | "decided" | "issued">("need");
  const [cardGroup, setCardGroup] = useState<"task" | "film">("task");
  const [manualOpen, setManualOpen] = useState(false);
  const [result, setResult] = useState<IssueResult | null>(null);
  const [lastIssued, setLastIssued] = useState<IssuedResult | null>(null);
  // Раздел про единую форму резки — один общий модальный CuttingForm для
  // всех сценариев резки+выдачи на этом экране (точечный донор у строки
  // задания, план резки на несколько строк сразу, ручной подбор без
  // задания), вместо трёх разных модалок/мутаций раньше. onDone у каждого
  // вызова свой — одиночная резка заводит карточку "Выдано" (lastIssued),
  // групповой план резки просто закрывается и инвалидирует кэш заданий.
  const [cuttingSession, setCuttingSession] = useState<{
    donor: MaterialUnit;
    widthCuts: CuttingFormInitialWidthCut[];
    onDone: (res: CuttingRecipeResponse) => void;
  } | null>(null);

  // Раздел про разбор задания единой таблицей — план ЕЩЁ НЕ выполненный
  // физически, поэтому сам по себе не бьёт в бэкенд — просто накапливает
  // уже посчитанные планы резки (CuttingPlanGroupButton/ManualCuttingPlanModal
  // — тот же /units/cutting-plan запрос, что и раньше). Только групповые
  // планы — одиночные резки по одной строке (без группы) сюда не попадают,
  // остаются как были (свой cuttingSession/CuttingForm). В отличие от
  // прошлой версии, этот батч — не только печать: "Выполнить всё"
  // (executeAllDecisions ниже) реально режет каждую запись.
  const [cuttingBatch, setCuttingBatch] = useState<CuttingBatchEntry[]>([]);
  const [cuttingBatchOpen, setCuttingBatchOpen] = useState(false);
  // Раздел про разбор задания единой таблицей — сопроводительный лист,
  // отдельный от «Списка на резку», по одному заданию за раз.
  const [slipModalOpen, setSlipModalOpen] = useState(false);
  const [slipTaskId, setSlipTaskId] = useState<number | undefined>(undefined);
  const addToCuttingBatch = (entry: CuttingBatchEntry) =>
    setCuttingBatch((prev) => (prev.some((e) => e.donorUnitId === entry.donorUnitId) ? prev : [...prev, entry]));
  const removeFromCuttingBatch = (donorUnitId: number) =>
    setCuttingBatch((prev) => prev.filter((e) => e.donorUnitId !== donorUnitId));

  // Раздел про разбор задания единой таблицей — решения "выдать со
  // склада" (stock_matches из /units/cutting-plan), тот же принцип
  // отложенного выполнения, что и у cuttingBatch выше, только для готовых
  // штрипсов, не требующих резки вообще.
  const [stockDecisions, setStockDecisions] = useState<StockDecision[]>([]);
  const addStockDecision = (d: StockDecision) =>
    setStockDecisions((prev) => (prev.some((e) => e.lineId === d.lineId) ? prev : [...prev, d]));
  const removeStockDecision = (lineId: number) => setStockDecisions((prev) => prev.filter((e) => e.lineId !== lineId));
  const decidedLineIds = useMemo(() => {
    const ids = new Set(stockDecisions.map((d) => d.lineId));
    for (const entry of cuttingBatch) for (const p of entry.pieces) if (p.productionTaskLineId != null) ids.add(p.productionTaskLineId);
    return ids;
  }, [stockDecisions, cuttingBatch]);
  const [executingAll, setExecutingAll] = useState(false);

  // Раздел про кнопки действий прямо в строке — статус + готовые
  // действия по каждой строке (по line.id), собранные из всех
  // GroupStatusReporter на странице (один на группу материал+цвет+
  // толщина+участок). Мержится вглубь — репортёр каждой группы пишет
  // только свои строки, не трогая чужие.
  const [lineInfoMap, setLineInfoMap] = useState<Map<number, RowInfo>>(new Map());
  const reportGroupInfos = (infos: Map<number, RowInfo>) =>
    setLineInfoMap((prev) => {
      const next = new Map(prev);
      infos.forEach((v, k) => next.set(k, v));
      return next;
    });
  // Раздел про кнопки действий прямо в строке — "Свой донор и раскрой"
  // раньше открывался из панели решения в развороте (своя модалка на
  // группу); теперь одна общая модалка на всю страницу, чтобы кнопка в
  // колонке "Действия" могла её открыть без разворота строки.
  const [manualPickerTarget, setManualPickerTarget] = useState<{ sku: MaterialSku; rows: QueueRowData[] } | null>(null);
  // Раздел про действия кнопками в строке — раскрывающийся список убран
  // целиком (был лишним: печать/приёмка возврата уже кнопки в строке,
  // Использовать/+ В резку/Свой донор — тоже). Осталось ровно одно, что
  // не сводится к кнопке в узкой колонке — полный разбор строки (точное
  // совпадение/донор/замена материала/донор+раскрой группы) — теперь
  // модалка "Подробнее", а не разворот таблицы.
  const [detailRow, setDetailRow] = useState<NeedTableRow | null>(null);

  // Раздел про разбор задания единой таблицей — решение принимается в
  // таблице заранее (склад/резка), выполнение — здесь и только по этой
  // кнопке, по очереди (не Promise.all — чтобы точно знать, какое именно
  // решение упало и почему, а не только "что-то из N не получилось").
  // Успешные решения убираются из стейта сразу; проваленные остаются —
  // можно поправить и попробовать снова.
  const executeAllDecisions = async () => {
    if (executingAll) return;
    setExecutingAll(true);
    const failed: { label: string; error: string }[] = [];
    let okCount = 0;
    // Общий штрипс (одна единица на несколько строк) выдаётся один раз —
    // под первую строку; остальные берут его как общий рулон участка.
    const issuedUnits = new Set<number>();
    for (const d of stockDecisions) {
      try {
        if (!issuedUnits.has(d.unitId)) {
          await issueUnitDirect(d.unitId, d.area, d.lineId, toOccurredAtIso(occurredAt));
          issuedUnits.add(d.unitId);
        }
        removeStockDecision(d.lineId);
        okCount++;
      } catch (e) {
        failed.push({ label: `${d.label} — штрипс ${rollNo(d.unitId)}`, error: issueErrorMessage(e, "не удалось выдать") });
      }
    }
    for (const entry of cuttingBatch) {
      try {
        await executeCuttingRecipe({
          donor_unit_id: entry.donorUnitId,
          width_cuts: entry.pieces.map((p) => ({
            width_mm: p.widthMm,
            destination: { kind: "issue", area: p.area, production_task_line_id: p.productionTaskLineId },
            actual_length_m: entry.donorLengthM,
          })),
          occurred_at: toOccurredAtIso(occurredAt),
        });
        removeFromCuttingBatch(entry.donorUnitId);
        okCount++;
      } catch (e) {
        failed.push({ label: `Донор ${rollNo(entry.donorUnitId)} (${entry.pieces.length} кус.)`, error: issueErrorMessage(e, "не удалось разрезать") });
      }
    }
    setExecutingAll(false);
    qc.invalidateQueries({ queryKey: ["production-tasks"] });
    qc.invalidateQueries({ queryKey: ["issue-available-units"] });
    qc.invalidateQueries({ queryKey: ["cutting-plan"] });
    if (failed.length === 0) {
      message.success(`Выполнено решений: ${okCount}`);
    } else {
      Modal.warning({
        title: `Выполнено ${okCount} из ${okCount + failed.length} — есть ошибки`,
        content: (
          <ul style={{ paddingLeft: 18, margin: 0 }}>
            {failed.map((f, i) => (
              <li key={i}>
                {f.label}: {f.error}
              </li>
            ))}
          </ul>
        ),
      });
    }
  };

  const [manualSkuId, setManualSkuId] = useState<number | null>(null);
  const [manualArea, setManualArea] = useState<AreaValue | null>(null);
  const [manualForm] = Form.useForm<{ width_mm: number; length_m: number }>();
  // Раздел про нарезку в ширину без привязки к заданию — донор,
  // предложенный на "Найти и выдать" ниже, когда точного совпадения по
  // ширине нет (тот же outcome="donor_suggested", что и в задачной
  // очереди выше, просто своё состояние — эта карточка донора относится к
  // ручному подбору, не к выбранной строке задания).
  const [manualDonor, setManualDonor] = useState<DonorSuggestion | null>(null);
  // Раздел про выдачу мимо хаба — на своём складе ничего не нашлось, но
  // на другом складе материал есть (backend/api/units.py::issue_to_area
  // отдаёт elsewhere_warehouse_name) — подсказать подготовить и отправить
  // через хаб, а не сразу вести к заявке на закупку.
  const [manualElsewhere, setManualElsewhere] = useState<string | null>(null);
  const [shortageModalOpen, setShortageModalOpen] = useState(false);
  const [shortageForm] = Form.useForm<PurchaseRequestShopFloorCreate>();
  // Раздел про дату операции задним числом — одно поле на весь экран
  // выдачи (не дублируется в каждой из веток ниже): выдача обычно
  // фиксируется по факту через день-два после самого события.
  const [occurredAt, setOccurredAt] = useState<Dayjs | null>(null);

  const skusQuery = useQuery({ queryKey: ["material-skus"], queryFn: () => listMaterialSkus() });
  // Раздел про аналоги ширин при выдаче — редко меняются, грузим один раз
  // на весь экран и используем во всех местах ручного подбора донора, для
  // визуальной консистентности с бэкендом (тот уже принимает аналог как
  // совпадение без override_strip_width, см. _validate_matches_task_line).
  const widthAnalogsQuery = useQuery({ queryKey: ["width-analogs"], queryFn: listWidthAnalogGroups });
  const widthAnalogGroups = widthAnalogsQuery.data ?? [];
  // Раздел про нулевые позиции при выдаче — отдельный запрос только для
  // списка в ручном подборе (skusQuery выше нужен целиком, включая
  // позиции без остатка: findSku по строке задания должен находить их
  // тоже, иначе очередь по заданию не сможет предложить донора/заявку на
  // нехватку для материала, которого сейчас физически нет вообще).
  const manualSkusQuery = useQuery({ queryKey: ["material-skus", "in-stock"], queryFn: () => listMaterialSkus(true) });
  // Выдача — только плёнка: строки без плёнки (сборка, склейка…) сюда не
  // попадают. select — только для этого экрана, общий кэш заданий не трогаем.
  const tasksQuery = useQuery({
    queryKey: ["production-tasks"],
    queryFn: listProductionTasks,
    select: (tasks) => tasks.map((t) => ({ ...t, lines: t.lines.filter((l) => l.material !== null) })),
  });
  const areasQuery = useQuery({ queryKey: ["areas"], queryFn: listAreas });
  const areaLabel = (code: string) => areasQuery.data?.find((a) => a.code === code)?.name ?? code;
  // Раздел про отключение распределения по дням — для такого участка
  // строка в очереди "week" не помечается как "не распределено" (это её
  // нормальное постоянное состояние, а не сигнал забытой распределения).
  const areaRequiresDailyPlan = (code: string) => areasQuery.data?.find((a) => a.code === code)?.requires_daily_plan ?? true;
  const areaOptions = (areasQuery.data ?? []).filter((a) => a.is_active).map((a) => ({ value: a.code, label: a.name }));
  const taskOptions = (tasksQuery.data ?? [])
    .filter((t) => t.is_active)
    .map((t) => ({ value: t.id, label: t.product_model_name ?? t.name ?? `Задание №${t.id}` }));

  // Раздел про площадки — домашний склад участка (Северный/Фабрика), чтобы
  // подбор донора в первую очередь искал "на своём" складе и предупреждал,
  // если оператор всё же берёт единицу с другого. Участок без площадки —
  // домашнего склада нет, ищем/выдаём как раньше, без ограничения.
  const sitesQuery = useQuery({ queryKey: ["sites"], queryFn: listSites });
  const warehousesQuery = useQuery({ queryKey: ["warehouses"], queryFn: listWarehouses });
  const homeWarehouseFor = (areaCode: string | null | undefined): { id: number; name: string } | null => {
    const area = areasQuery.data?.find((a) => a.code === areaCode);
    if (!area?.site_id) return null;
    const site = sitesQuery.data?.find((s) => s.id === area.site_id);
    if (!site) return null;
    const warehouse = warehousesQuery.data?.find((w) => w.id === site.warehouse_id);
    return warehouse ? { id: warehouse.id, name: warehouse.name } : null;
  };

  // Раздел про выдачу мимо хаба — раньше здесь было "предупредить, но
  // разрешить" (Modal.confirm с кнопкой-обходом). Теперь это настоящий
  // жёсткий блок на бэкенде (assert_area_home_warehouse) — фронт только
  // объясняет причину заранее и не даёт кнопки "всё равно выдать", чтобы
  // не вести оператора к заведомо провальному запросу. Поиск в очереди
  // тоже теперь ограничен своим складом (backend/api/units.py::issue_to_area),
  // так что это предупреждение — подстраховка на редких путях (прямая
  // выдача конкретной единицы из карточки/списка), где единица уже
  // выбрана руками, а не найдена поиском.
  const confirmIfWrongWarehouse = (
    unitWarehouseName: string | null | undefined,
    areaCode: string | null | undefined,
    onConfirmed: () => void,
  ) => {
    const home = homeWarehouseFor(areaCode);
    if (!home || !unitWarehouseName || unitWarehouseName === home.name) {
      onConfirmed();
      return;
    }
    Modal.error({
      title: "Плёнка с другого склада — выдать нельзя",
      content: `Единица физически лежит на складе «${unitWarehouseName}», а для этого участка домашний склад — «${home.name}». Сначала переместите её через «Перемещения между складами», затем выдайте уже с домашнего склада.`,
      okText: "Понятно",
    });
  };

  // Раздел про видимость выданного вручную — "Выдано по заданиям" ниже
  // строится строго из строк заданий и никогда не покажет единицу,
  // выданную в обход задания (issueUnitDirect/manualDirectMutation и
  // т.п.). Отдельный запрос по статусу "Выдан участку" находит и такие
  // тоже — фильтруем на клиенте по отсутствию production_task_line_id
  // (обратное тому, что делает issuedLines).
  const manualIssuedQuery = useQuery({
    queryKey: ["issue-manual-issued", areaFilter],
    queryFn: () => searchUnits({ status: "Выдан_участку", area: areaFilter ?? undefined }),
  });
  const manualIssuedUnits = (manualIssuedQuery.data ?? []).filter((u) => !u.production_task_line_id);

  // --- Очередь: "запрошено сегодня/просрочено" (из распределения по дням)
  // и "задания недели" (остаток по строкам, для которых на сегодня ничего
  // не распределено) — раздел про экран выдачи: складу нужны
  // производственные задания, а не заказы покупателей.
  const today = dayjs().format("YYYY-MM-DD");

  // Строка попадает в очередь не по голому остатку штук, а по нехватке
  // уже выданной плёнки (shortfall_length_m, backend) — раздел про
  // «потребности» после выдачи: как только выдано достаточно на весь
  // план, строка уходит из очереди в «Выдано по заданиям», даже если
  // производство ещё не отчиталось о готовых деталях. Довыдача
  // открывается заново только отчётом о браке (см.
  // compute_shortfall_length_m) — сам факт остатка штук её не включает.
  // task.is_active — заархивированное задание (раздел про удаление
  // сущностей — задание с реальной историей выдачи нельзя удалить,
  // только заархивировать) не должно ни просить довыдать плёнку, ни
  // висеть в ленте расхода: экран "Выдача" раньше вообще не смотрел на
  // is_active, и заархивированное тестовое задание с ещё не выданными
  // строками продолжало значиться в очереди как реальная потребность.
  // Раздел про разбор задания единой таблицей — раньше строка с
  // remaining_pieces > 0, но уже выданной вплоть до shortfall_length_m
  // <= 0, полностью пропадала из очереди (видна была только позже, в
  // "Выдано по заданиям" далеко внизу экрана). Условие по
  // shortfall_length_m снято — такая строка остаётся в очереди со
  // статусом "выдано" (issuedNoteForLine в queueRow), не требуя листать
  // экран, чтобы понять, что по ней уже сделано.
  // Раздел про разбор задания единой таблицей — второе расширение
  // условия (после снятия shortfall_length_m > 0): строка с
  // remaining_pieces <= 0 (производство полностью завершено), но
  // issued_length_m > 0 (что-то по ней когда-то выдавалось), раньше жила
  // ТОЛЬКО в отдельной таблице "Выдано по заданиям" внизу экрана —
  // теперь остаётся прямо в очереди, той же строкой, статусом "выдано"
  // (issuedNoteForLine), просто ничего по ней уже не нужно решать.
  // Строка без остатка и без единой выдачи (пустая, ничего не было и
  // не нужно) по-прежнему не показывается — реального смысла в ней нет.
  //
  // Раздел про автоматический уход строк из очереди — раньше держали
  // строку в очереди, пока issued_length_m > 0 (а это поле, единожды
  // заполнившись, никогда не уменьшается — так что полностью
  // произведённая И полностью возвращённая строка висела бы в очереди
  // вечно). Теперь смотрим, есть ли ФИЗИЧЕСКИ незавершённый рулон:
  // "Выдан_участку"/"В_перемещении" — ещё у участка/едет; "На_хранении"
  // с area всё ещё указанным — хаб принял, но участку ещё не довыдали
  // локально (receive_transfer_line area не трогает); "На_хранении" с
  // area=null — это уже настоящий возврат (return_unit area очищает) —
  // такое реальным "незавершённым" не считаем. Условие живое: если
  // quantity_pieces потом вырастет, remaining_pieces > 0 вернёт строку
  // в очередь само, без вмешательства.
  const activeLines = useMemo(
    () =>
      (tasksQuery.data ?? [])
        .filter((task) => task.is_active)
        .flatMap((task) =>
          task.lines
            // is_closed — раздел про закрытие строки задания по выдаче:
            // ручной флаг поверх остатка/выданного, для строк, где всё уже
            // физически улажено вне этого экрана, а отчёты дозаводятся
            // только сейчас.
            .filter((line) => {
              if (line.is_closed) return false;
              if (line.remaining_pieces > 0) return true;
              return (line.issued_units ?? []).some((u) => u.status !== "На_хранении" || u.area != null);
            })
            .map((line) => ({ task, line })),
        ),
    [tasksQuery.data],
  );

  const assignmentRows = useMemo(() => {
    const rows = activeLines.flatMap(({ task, line }) =>
      (line.assignments ?? [])
        .filter((a) => a.date <= today)
        .map((assignment) => ({ task, line, assignment, overdue: assignment.date < today })),
    );
    rows.sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return a.assignment.date.localeCompare(b.assignment.date);
    });
    return rows;
  }, [activeLines, today]);

  const linesWithTodayAssignment = useMemo(() => new Set(assignmentRows.map((r) => r.line.id)), [assignmentRows]);
  const weekRows = useMemo(
    () => activeLines.filter(({ line }) => !linesWithTodayAssignment.has(line.id)),
    [activeLines, linesWithTodayAssignment],
  );

  const matchesFilter = (task: ProductionTask, line: ProductionTaskLine) => {
    if (areaFilter && task.area !== areaFilter) return false;
    if (taskFilter && task.id !== taskFilter) return false;
    if (search.trim()) {
      // По словам, в любом порядке: «бьянко 150», «эталон», «2054» (№ штрипса/донора).
      const info = lineInfoMap.get(line.id);
      const haystack = [
        line.part_name ?? "",
        task.product_model_name ?? task.name ?? "",
        task.production_order_name ?? "",
        line.material,
        line.color,
        `${line.strip_width_mm || line.width_mm} мм`,
        ...(line.issued_units ?? []).map((u) => u.id),
        info?.status.kind === "stock" ? info.status.match.unit_id : "",
        info?.donorUnitId ?? "",
      ]
        .join(" ")
        .toLowerCase()
        .replace(/ё/g, "е");
      const words = search.trim().toLowerCase().replace(/ё/g, "е").replace(/№/g, " ").split(/\s+/).filter(Boolean);
      if (!words.every((w) => haystack.includes(w))) return false;
    }
    return true;
  };

  const filteredAssignmentRows = assignmentRows.filter((r) => matchesFilter(r.task, r.line));
  const filteredWeekRows = weekRows.filter((r) => matchesFilter(r.task, r.line));

  const overdueCount = assignmentRows.filter((r) => r.overdue).length;
  const todayCount = assignmentRows.length - overdueCount;
  // Раздел про разбор задания единой таблицей — weekRows теперь включает
  // и уже полностью выданные строки (видны в очереди статусом "выдано"
  // вместо исчезновения), но счётчики ниже по-прежнему должны отражать
  // реальную НЕХВАТКУ, не общее число строк в очереди.
  const weekRowsNeedingMaterial = weekRows.filter((r) => r.line.shortfall_length_m > 0);
  const areasWaiting = new Set(
    [...assignmentRows, ...weekRowsNeedingMaterial].filter((r) => r.line.shortfall_length_m > 0).map((r) => r.task.area),
  ).size;

  // Раздел про триггер "когда можно забирать" — раньше факт "производство
  // по строке уже полностью готово, но рулон всё ещё числится за
  // участком" был виден только внутри общей очереди (колонка "Нужно /
  // факт", тег "🏁 работа завершена"), легко потеряться среди остальных
  // строк. Отдельный banner наверху экрана — какие задания уже готовы
  // целиком (remaining_pieces<=0 по всем строкам с остатком рулонов) и
  // что именно ещё физически лежит у участка, нужно забрать обратно на
  // склад — прямой ответ на "триггер" для кладовщика/логиста.
  const pendingReturnByTask = useMemo(() => {
    const map = new Map<number, { task: ProductionTask; units: ProductionTaskLineIssuedUnit[] }>();
    for (const { task, line } of activeLines) {
      if (line.remaining_pieces > 0) continue;
      const outstanding = line.issued_units.filter((u) => u.status === "Выдан_участку");
      if (outstanding.length === 0) continue;
      const entry = map.get(task.id) ?? { task, units: [] };
      const seen = new Set(entry.units.map((u) => u.id));
      for (const u of outstanding) if (!seen.has(u.id)) entry.units.push(u);
      map.set(task.id, entry);
    }
    return [...map.values()];
  }, [activeLines]);

  // --- Выбранная потребность: авто-подбор точного/донор-штрипса сразу
  // после выбора строки в очереди, без лишнего клика "искать".
  const selectedSku = selected ? findSku(skusQuery.data, selected.line.material, selected.line.color, selected.line.thickness) : undefined;
  const selectedStripWidth = selected ? selected.line.strip_width_mm || selected.line.width_mm : 0;
  // Раздел про общий погонаж на партию деталей — раньше искали и выдавали
  // строго на ОДНУ деталь (line.length_m), даже когда по строке нужно
  // сразу несколько: 4 детали одной ширины оборачивались 4 отдельными
  // подборами донора (иногда — 4 разными физическими штрипсами), хотя
  // одного достаточной длины хватило бы на все 4 (порезать по длине уже
  // на участке). См. neededLengthM выше.
  const selectedNeededLengthM = selected ? neededLengthM(selected) : 0;

  // findMutation (issueUnit/POST /units/issue) сам выдаёт единицу и коммитит
  // это в БД, когда находит точное совпадение по ширине — раньше вызывался
  // сразу по выбору строки в очереди, без подтверждения (клик по карточке
  // = реальное списание склада, баг: строку выбирали просто посмотреть, а
  // плёнка уже уходила). Теперь при точном совпадении вызывать его вообще
  // не нужно — оно видно и так из уже загруженного availableQuery
  // (exactMatch ниже), показывается предпросмотром, а выдаёт по клику
  // "Выдать" уже issueUnitDirect/directMutation (та же функция, что и в
  // "Показать остатки" ниже) — сам find-эндпоинт вызывается только когда
  // точного совпадения точно нет, тогда он ничего сам не выдаст, только
  // предложит донора (или скажет, что и донора нет).
  const findMutation = useMutation({
    mutationFn: () =>
      issueUnit({
        material: selectedSku!.material.name,
        color: selectedSku!.color.name,
        thickness: selectedSku!.thickness.value_mm,
        manufacturer: selectedSku!.manufacturer.name,
        width_mm: selectedStripWidth,
        length_m: selectedNeededLengthM,
        area: selected!.task.area,
        production_task_line_id: selected!.line.id,
        occurred_at: toOccurredAtIso(occurredAt),
      }),
    onSuccess: (res) => setResult(res),
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось подобрать штрипс")),
  });

  useEffect(() => {
    if (!selected || !selectedSku) return;
    setResult(null);
    setLastIssued(null);
    setSubstituteSkuId(undefined);
  }, [selected?.line.id, selectedSku?.id]);

  // Раздел про замену плёнки на выдаче — сток по SKU, выбранному оператором
  // вместо номенклатуры строки задания (та же форма запроса, что и
  // availableQuery ниже, только по другому SKU).
  const substituteSku = skusQuery.data?.find((s) => s.id === substituteSkuId) ?? null;
  const substituteAvailableQuery = useQuery({
    queryKey: ["issue-substitute-available", substituteSkuId],
    queryFn: () =>
      searchUnits({
        material: substituteSku!.material.name,
        color: substituteSku!.color.name,
        thickness: substituteSku!.thickness.value_mm,
        manufacturer: substituteSku!.manufacturer.name,
        status: "На_хранении",
      }),
    enabled: !!substituteSku,
  });

  const availableQuery = useQuery({
    queryKey: ["issue-available-units", selectedSku?.id],
    queryFn: () =>
      searchUnits({
        material: selectedSku!.material.name,
        color: selectedSku!.color.name,
        thickness: selectedSku!.thickness.value_mm,
        manufacturer: selectedSku!.manufacturer.name,
        status: "На_хранении",
      }),
    enabled: !!selectedSku,
  });

  // Точное совпадение по ширине — предпросмотр из уже загруженного
  // availableQuery (без похода на бэкенд), с сортировкой по длине, чтобы
  // предлагать в первую очередь короткий, но достаточный кусок (не
  // залёживать длинные, тот же принцип, что и у backend-подбора). Явное
  // подтверждение — кнопка "Выдать" ниже (directMutation), не сам факт
  // выбора строки.
  const exactMatch = useMemo(() => {
    if (!selected) return null;
    const candidates = (availableQuery.data ?? []).filter(
      (u) => isWidthMatch(widthAnalogGroups, u.width_mm, selectedStripWidth) && u.length_m >= selectedNeededLengthM,
    );
    if (candidates.length === 0) return null;
    // Точное совпадение раньше аналога — тот же приоритет, что и у
    // бэкенда (find_exact_stock_match), потом уже по длине.
    return [...candidates].sort((a, b) => {
      const aExact = a.width_mm === selectedStripWidth ? 0 : 1;
      const bExact = b.width_mm === selectedStripWidth ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      return a.length_m - b.length_m;
    })[0];
  }, [selected, availableQuery.data, selectedStripWidth, selectedNeededLengthM, widthAnalogGroups]);

  // findMutation вызывается только когда точного совпадения точно нет
  // (availableQuery уже загрузился и exactMatch пуст) — тогда find-эндпоинт
  // сам ничего не выдаст, только предложит донора или скажет, что и его нет.
  useEffect(() => {
    if (!canIssue) return;
    if (!selected || !selectedSku) return;
    if (availableQuery.isLoading || exactMatch) return;
    findMutation.mutate();
    // findMutation.mutate имеет стабильную идентичность между рендерами (react-query) — не в зависимостях намеренно
  }, [canIssue, selected?.line.id, selectedSku?.id, availableQuery.isLoading, exactMatch]);

  // --- Нехватка остатка под выбранную строку задания (раздел про замену
  // "Заказов покупателей" — нехватка обнаруживается в моменте выдачи, не
  // на отдельном экране планирования). needed — на весь довыдаваемый
  // остаток строки задания (shortfall_length_m — раздел про очередь
  // «потребности» после выдачи), не голый остаток по штукам: то, что уже
  // выдано, не должно завышать площадь для заявки на закупку.
  const neededM2 = selected ? (selectedStripWidth / 1000) * selected.line.shortfall_length_m : 0;
  const availableM2 = (availableQuery.data ?? []).reduce((sum, u) => sum + u.area_m2, 0);
  const shortfallM2 = Math.max(0, Math.round((neededM2 - availableM2) * 100) / 100);

  const shopFloorRequestMutation = useMutation({
    mutationFn: (payload: PurchaseRequestShopFloorCreate) => createShopFloorPurchaseRequest(payload),
    onSuccess: () => {
      message.success("Заявка на закупку отправлена");
      setShortageModalOpen(false);
    },
    onError: () => message.error("Не удалось создать заявку"),
  });

  const openShortageModal = () => {
    if (!selectedSku || !selected) return;
    shortageForm.setFieldsValue({
      material: selectedSku.material.name,
      color: selectedSku.color.name,
      thickness: selectedSku.thickness.value_mm,
      requested_area_m2: shortfallM2,
      note: `${selected.line.part_name ?? "Деталь"} — ${selected.task.product_model_name ?? selected.task.name ?? `Задание №${selected.task.id}`}`,
    });
    setShortageModalOpen(true);
  };

  const directMutation = useMutation({
    mutationFn: ({ unitId, override = false }: { unitId: number; override?: boolean }) =>
      issueUnitDirect(unitId, selected!.task.area, selected!.line.id, toOccurredAtIso(occurredAt), override, override),
    onSuccess: (unit) => {
      // Раздел про выдачу мимо хаба — участок физически на другом складе
      // (units.py::auto_transfer_if_wrong_warehouse): сервер сам отправил
      // единицу в хаб на перемещение вместо выдачи, "Выдано" здесь было бы
      // неправдой — единица ещё не у участка, только в пути.
      if (unit.status === "В_перемещении") {
        message.success("Материал физически на другом складе — автоматически отправлен в хаб на перемещение");
        qc.invalidateQueries({ queryKey: ["issue-available-units"] });
        qc.invalidateQueries({ queryKey: ["issue-substitute-available"] });
        return;
      }
      setLastIssued({ unit, remainder: null, remainderPlaced: false });
      setResult(null);
      qc.invalidateQueries({ queryKey: ["issue-available-units"] });
      qc.invalidateQueries({ queryKey: ["issue-substitute-available"] });
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось выдать")),
  });

  // Один и тот же результат одиночной резки+выдачи (result.donor, строка
  // остатков на складе, ручной подбор) заводится в уже существующую
  // карточку "Выдано / остаток" ниже (lastIssued) — та же полировка
  // (печать бирки, подсказка адреса для остатка), что была у прежнего
  // atomicDonorMutation, теперь общая для всех трёх мест.
  const finishSingleCut = (res: CuttingRecipeResponse) => {
    const piece = res.width_results[0] ?? res.length_result;
    if (!piece) return;
    setLastIssued({
      unit: piece.unit,
      remainder: res.donor_remainder.status === "На_хранении" ? res.donor_remainder : null,
      remainderPlaced: false,
    });
    setResult(null);
    qc.invalidateQueries({ queryKey: ["issue-available-units"] });
  };

  const remainderSuggestion = useQuery({
    queryKey: ["suggest-location", "issue-remainder", lastIssued?.remainder?.id],
    queryFn: () =>
      suggestLocation({
        material_sku_id: lastIssued!.remainder!.material_sku.id,
        is_strip: lastIssued!.remainder!.is_strip,
      }),
    enabled: !!lastIssued?.remainder && !lastIssued.remainderPlaced,
  });

  const placeRemainderMutation = useMutation({
    mutationFn: (locationCode: string) =>
      placeUnit(lastIssued!.remainder!.id, locationCode, toOccurredAtIso(occurredAt)),
    onSuccess: () => {
      setLastIssued((prev) => (prev ? { ...prev, remainderPlaced: true } : prev));
      message.success("Остаток размещён");
    },
    onError: () => message.error("Не удалось разместить остаток"),
  });

  const finishAndReset = () => {
    setSelected(null);
    setResult(null);
    setLastIssued(null);
  };

  // --- Ручной подбор без привязки к заданию (редкий случай — плёнка не
  // относится ни к одному заданию). Строгая проверка соответствия здесь
  // не применяется, т.к. нет строки задания, с которой сверять.
  const manualSku = skusQuery.data?.find((s) => s.id === manualSkuId) ?? null;

  useEffect(() => {
    if (!prefill || !skusQuery.data) return;
    if (prefill.material && prefill.color && prefill.thickness) {
      const match = findSku(skusQuery.data, prefill.material, prefill.color, prefill.thickness);
      if (match) setManualSkuId(match.id);
    }
  }, [prefill, skusQuery.data]);

  const manualAvailableQuery = useQuery({
    queryKey: ["issue-manual-available", manualSkuId],
    queryFn: () =>
      searchUnits({
        material: manualSku!.material.name,
        color: manualSku!.color.name,
        thickness: manualSku!.thickness.value_mm,
        manufacturer: manualSku!.manufacturer.name,
        status: "На_хранении",
      }),
    enabled: !!manualSku,
  });

  const manualDirectMutation = useMutation({
    mutationFn: (unitId: number) => issueUnitDirect(unitId, manualArea!, undefined, toOccurredAtIso(occurredAt)),
    onSuccess: (unit) => {
      setLastIssued({ unit, remainder: null, remainderPlaced: false });
      setManualDonor(null);
      qc.invalidateQueries({ queryKey: ["issue-manual-available"] });
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось выдать")),
  });

  const manualFindMutation = useMutation({
    mutationFn: (v: { width_mm: number; length_m: number }) =>
      issueUnit({
        material: manualSku!.material.name,
        color: manualSku!.color.name,
        thickness: manualSku!.thickness.value_mm,
        manufacturer: manualSku!.manufacturer.name,
        width_mm: v.width_mm,
        length_m: v.length_m,
        area: manualArea!,
        occurred_at: toOccurredAtIso(occurredAt),
      }),
    onSuccess: (res) => {
      if (res.outcome === "issued" && res.unit) {
        setLastIssued({ unit: res.unit, remainder: null, remainderPlaced: false });
        setManualDonor(null);
        setManualElsewhere(null);
        qc.invalidateQueries({ queryKey: ["issue-manual-available"] });
      } else if (res.outcome === "not_found") {
        setManualDonor(null);
        setManualElsewhere(res.elsewhere_warehouse_name ?? null);
        if (!res.elsewhere_warehouse_name) {
          message.warning("Точного совпадения по ширине нет — донора тоже нет, режьте новый рулон");
        }
      } else if (res.outcome === "donor_suggested" && res.donor) {
        setManualDonor(res.donor);
        setManualElsewhere(null);
      }
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось оформить выдачу")),
  });

  // Раздел про закрытие строки задания по выдаче — строка, по которой всё
  // уже физически улажено (выдано/возвращено/списано) вне этого экрана,
  // а отчёты дозаводятся только сейчас, иначе висела бы в "Выдано по
  // заданиям" бессрочно (issued_length_m не уменьшается никогда).
  const closeLineMutation = useMutation({
    mutationFn: ({ taskId, lineId, isClosed }: { taskId: number; lineId: number; isClosed: boolean }) =>
      closeTaskLine(taskId, lineId, isClosed),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["production-tasks"] });
      message.success("Строка закрыта по выдаче");
    },
    onError: (e) => message.error(issueErrorMessage(e, "Не удалось закрыть строку")),
  });

  // Раздел про разбор задания единой таблицей — строка "выдано" не должна
  // молча пропадать из очереди, как только shortfall_length_m обнулился
  // (см. allTaskLines ниже, ослабленный фильтр); достаточно ли выдано, и
  // в каком состоянии физически находится кусок — реальный статус
  // единиц (status теперь приходит на ProductionTaskLineIssuedUnit)
  // важнее любого производного статуса плана резки, раз материал уже
  // решён по факту.
  const issuedNoteForLine = (line: ProductionTaskLine): string | null => {
    if (line.shortfall_length_m > 0) return null;
    const units = line.issued_units ?? [];
    if (units.some((u) => u.status === "В_перемещении")) return "🚚 едет через хаб";
    if (units.some((u) => u.status === "На_хранении")) return "🏭 на складе, ждёт довыдачи";
    return "✅ выдано";
  };

  // Раздел про рабочий экран участка — факт расхода и остаток "к сдаче"
  // считаем на фронте из уже загруженных issued_units, без нового
  // запроса: remaining_length_m каждой единицы уже приходит с бэкенда
  // (_task_line_out → _unit_consumed_length_m, пересчитывается по ВСЕМ
  // отчётам на эту единицу), поэтому расход конкретного куска — это его
  // текущая length_m минус remaining_length_m, независимо от того,
  // вернули кусок на склад или нет. "К сдаче" — то, что физически ещё не
  // в остатке склада (статус ещё Выдан_участку/В_перемещении); "На
  // складе" — то же самое, но возврат уже приняли (AcceptReturnButton).
  const lineActuals = (line: ProductionTaskLine) => {
    const units = line.issued_units ?? [];
    let consumed = 0;
    let stillOut = 0;
    let backInStock = 0;
    // Раздел про номера штрипсов на рабочем экране — отдельно от сумм
    // держим сами единицы по обеим группам, чтобы вывести кликабельный
    // номер каждого рулона (провалиться в его карточку), не только итог.
    const stillOutUnits: ProductionTaskLineIssuedUnit[] = [];
    const backInStockUnits: ProductionTaskLineIssuedUnit[] = [];
    for (const u of units) {
      const remaining = u.remaining_length_m ?? u.length_m;
      consumed += u.length_m - remaining;
      if (u.status === "На_хранении") {
        backInStock += remaining;
        backInStockUnits.push(u);
      } else {
        stillOut += remaining;
        stillOutUnits.push(u);
      }
    }
    return {
      consumed: Math.max(0, Math.round(consumed * 100) / 100),
      stillOut: Math.round(stillOut * 100) / 100,
      backInStock: Math.round(backInStock * 100) / 100,
      stillOutUnits,
      backInStockUnits,
    };
  };

  // Номер рулона — кликабельный, ведёт в карточку единицы (тот же переход,
  // что "Остатки"/"Карточка материала" уже используют — navigate с
  // unitId в state, UnitCard.tsx сам подхватывает и грузит по id).
  const UnitLink = ({ id }: { id: number }) => (
    <a onClick={() => navigate("/m/unit-card", { state: { unitId: id } })}>{rollNo(id)}</a>
  );

  // Та же категоризация, что renderStatusPill превращает в пилюлю —
  // нужна отдельно (без JSX), чтобы фильтр по статусу сверху совпадал
  // буквально с тем, что видно в колонке "Статус".
  const rowStatusKind = (row: TableRow): StatusFilterValue | undefined => {
    if (row.kind === "manual") return "manual";
    if (issuedNoteForLine(row.line)) return "issued";
    if (decidedLineIds.has(row.line.id)) return "decided";
    switch (lineInfoMap.get(row.line.id)?.status.kind) {
      case "stock":
        return "stock";
      case "cut_planned":
        return "cut";
      case "no_donor":
        return "no_donor";
      default:
        return undefined;
    }
  };

  const renderStatusPill = (status: RowStatus | undefined, issuedNote: string | null) => {
    if (issuedNote) return <Tag color="green">{issuedNote}</Tag>;
    if (!status) return null;
    switch (status.kind) {
      case "stock":
        return <Tag color="green">✅ {rollNo(status.match.unit_id)}{status.match.shared ? " · общий" : ""}</Tag>;
      case "cut_planned":
        return <Tag color="gold">✂️ резка</Tag>;
      case "no_donor":
        return <Tag color="red">✖ нет</Tag>;
      case "decided":
        return <Tag color="processing">🕒 решено</Tag>;
      default:
        return null;
    }
  };

  // Раздел про разбор задания единой таблицей — единая плотная таблица
  // вместо карточек: нужды по заданиям (assignmentRows/weekRows, включая
  // уже выданные — см. activeLines) плюс единицы, выданные без привязки
  // к заданию (manualIssuedUnits) — тем же способом, что раньше показывали
  // две отдельные таблицы внизу экрана ("Выдано по заданиям"/"Выдано
  // вручную"), теперь просто ещё строки этой же таблицы.
  const needTableRows: NeedTableRow[] = [
    ...filteredAssignmentRows.map((r) => ({
      kind: "need" as const,
      key: `need-${r.line.id}-${r.assignment.id}`,
      ...r,
      variant: "today" as const,
    })),
    ...filteredWeekRows.map((r) => ({
      kind: "need" as const,
      key: `need-${r.line.id}-week`,
      ...r,
      variant: "week" as const,
    })),
  ];
  const manualTableRows: ManualTableRow[] = manualIssuedUnits.map((u) => ({ kind: "manual" as const, key: `manual-${u.id}`, unit: u }));
  const tableRows: TableRow[] = [...needTableRows, ...manualTableRows];

  // Раздел про общий штрипс на детали одного задания — при "Взять со
  // склада" по одной строке ищем в ТОМ ЖЕ задании другие ещё не решённые
  // строки такой же ширины штрипса, у которых уже есть свой готовый
  // точный донор (свой физический штрипс на каждую — один рулон одной
  // выдачей не покрывает несколько строк, но при наличии на складе НЕСКОЛЬКИХ
  // штрипсов такой ширины отдельные решения по ним можно принять одним
  // действием, не щёлкая "✓" по очереди на каждой строке). needTableRows
  // (не activeLines) — те же строки, что сейчас видны с текущим фильтром,
  // иначе пришлось бы предлагать взять то, что оператор и не искал.
  const findStockSiblingCandidates = (row: NeedTableRow) => {
    if (row.kind !== "need") return [];
    const width = row.line.strip_width_mm || row.line.width_mm;
    const seen = new Set<number>();
    const result: { label: string; unitId: number; accept: () => void }[] = [];
    for (const other of needTableRows) {
      if (other.line.id === row.line.id || seen.has(other.line.id)) continue;
      if (other.task.id !== row.task.id) continue;
      if ((other.line.strip_width_mm || other.line.width_mm) !== width) continue;
      if (decidedLineIds.has(other.line.id)) continue;
      if (issuedNoteForLine(other.line)) continue;
      const otherInfo = lineInfoMap.get(other.line.id);
      if (otherInfo?.status.kind === "stock" && otherInfo.acceptStock) {
        seen.add(other.line.id);
        result.push({
          label: other.line.part_name ?? other.line.material ?? "",
          unitId: otherInfo.status.match.unit_id,
          accept: otherInfo.acceptStock,
        });
      }
    }
    return result;
  };
  // Фильтр по статусу — только на отображение; cuttingRows ниже считается
  // из needTableRows ДО этого фильтра, чтобы скрытие, скажем, уже решённых
  // строк не меняло состав группы для подбора донора по остальным.
  const filteredTableRows = statusFilter ? tableRows.filter((r) => rowStatusKind(r) === statusFilter) : tableRows;

  // Группы для подбора донора — только строки с реальной нехваткой
  // (shortfall_length_m > 0); уже выданные строки не должны попадать в
  // подбор донора вообще (их "нужная" длина — 0, испортило бы точное
  // совпадение фиктивным "нужно 0 м"). groupQueueRows группирует по
  // участку+материалу+цвету+толщине, включая группы из одной строки —
  // GroupStatusReporter/GroupDecisionPanel одинаково работают с любым
  // размером группы (см. пояснение в get_cutting_plan на бэкенде).
  const cuttingRows = needTableRows.filter((r) => r.line.shortfall_length_m > 0);
  const cuttingGroups = groupQueueRows(cuttingRows);
  const groupRowsByRowKey = new Map<string, QueueRowData[]>();
  for (const g of cuttingGroups) for (const r of g.rows) groupRowsByRowKey.set(`need-${r.line.id}-${r.assignment?.id ?? "week"}`, g.rows);

  // Раздел про разбор задания единой таблицей — второй печатный документ,
  // отдельный от «Списка на резку» (тот едет резчикам, без привязки к
  // заданию/участку): сопроводительный лист едет вместе с плёнкой на
  // конкретный участок под конкретное задание — что именно выдано
  // (деталь/кол-во/материал), явным номером рулона/штрипса на каждую
  // деталь, а не общей фразой. По одному заданию за раз (выбор — Select
  // рядом с кнопкой), не общий список сразу по всем.
  const printFactorySlip = (task: ProductionTask) => {
    const rows: Record<string, unknown>[] = [];
    for (const line of task.lines) {
      const issuedNote = issuedNoteForLine(line);
      if (issuedNote) {
        for (const u of line.issued_units) {
          rows.push({
            part: line.part_name ?? "Деталь",
            qty: `${line.quantity_pieces} шт`,
            material: `${line.material}, ${line.color}, ${line.thickness} мм`,
            unit: u.id,
            status:
              u.status === "В_перемещении"
                ? "🚚 едет через хаб"
                : u.status === "На_хранении"
                  ? "на складе, ждёт довыдачи"
                  : "✅ выдано",
          });
        }
        continue;
      }
      const stockDecision = stockDecisions.find((d) => d.lineId === line.id);
      if (stockDecision) {
        rows.push({
          part: line.part_name ?? "Деталь",
          qty: `${line.quantity_pieces} шт`,
          material: `${line.material}, ${line.color}, ${line.thickness} мм`,
          unit: `${stockDecision.unitId}`,
          status: "решено, ещё не выдано",
        });
        continue;
      }
      const cutPiece = cuttingBatch.flatMap((e) => e.pieces.map((p) => ({ e, p }))).find(({ p }) => p.productionTaskLineId === line.id);
      if (cutPiece) {
        rows.push({
          part: line.part_name ?? "Деталь",
          qty: `${line.quantity_pieces} шт`,
          material: `${line.material}, ${line.color}, ${line.thickness} мм`,
          unit: `${cutPiece.e.donorUnitId} (донор)`,
          status: "запланировано, ещё не разрезан",
        });
      }
    }
    if (rows.length === 0) {
      message.warning("По этому заданию пока нет ни выданного, ни принятых решений");
      return;
    }
    printReport(
      `Сопроводительный лист — ${task.product_model_name ?? task.name ?? `Задание №${task.id}`}`,
      [
        { key: "part", header: "Деталь" },
        { key: "qty", header: "Кол-во" },
        { key: "material", header: "Материал" },
        { key: "unit", header: "№ рулона/штрипса" },
        { key: "status", header: "Статус" },
      ],
      rows,
    );
  };

  // Раздел про разбор задания единой таблицей — тап по строке эквивалентен
  // старому "выбрать строку". В прежнем (карточном) дизайне клик по ЛЮБОЙ
  // строке — хоть одиночной, хоть внутри группы — всегда выставлял
  // selected и поднимал общую панель (точное совпадение/донор/замена
  // материала/правка ширины через CuttingForm) рядом с групповым
  // баннером, они не были взаимоисключающими. Первая версия разворота
  // это потеряла — привязала общую панель только к негрупповым строкам,
  // из-за чего "замена материала" и правка ширины пропали для всех
  // реальных (обычно групповых) строк. Починено: selected выставляется
  // для ЛЮБОЙ ещё не выданной строки-нужды, группа она или нет — теперь
  // через кнопку "Подробнее" (модалка), не разворот строки.
  const openDetail = (row: NeedTableRow) => {
    setSelected({ task: row.task, line: row.line, assignment: row.assignment });
    setDetailRow(row);
  };
  const closeDetail = () => {
    setDetailRow(null);
    setSelected(null);
  };

  // ── Вид карточками (планшет кладовщика, 30.09) ───────────────────────
  // Та же очередь и те же действия, что в таблице: карточка — задание окутки
  // (или плёнка+ширина штрипса на участке), внутри его детали со статусом и
  // одной крупной кнопкой. Решения копятся внизу экрана.
  const whenLabel = (row: NeedTableRow): { text: string; color: string } =>
    row.variant === "today"
      ? row.overdue
        ? { text: `просрочено ${dayjs(row.assignment!.date).format("DD.MM")}`, color: "error" }
        : { text: "сегодня", color: "orange" }
      : areaRequiresDailyPlan(row.task.area)
        ? { text: "не распределено по дням", color: "default" }
        : { text: "весь участок", color: "blue" };
  const inCardTab = (row: TableRow) => {
    const k = rowStatusKind(row);
    if (cardTab === "issued") return k === "issued" || k === "manual";
    if (cardTab === "decided") return k === "decided";
    return k !== "issued" && k !== "manual" && k !== "decided";
  };
  const acceptRow = (row: NeedTableRow) => {
    const info = lineInfoMap.get(row.line.id);
    if (info?.status.kind === "stock" && info.acceptStock) info.acceptStock();
    else if (info?.acceptCut) void info.acceptCut();
  };
  const readyRow = (row: NeedTableRow) => {
    if (decidedLineIds.has(row.line.id) || issuedNoteForLine(row.line)) return false;
    const info = lineInfoMap.get(row.line.id);
    return (info?.status.kind === "stock" && !!info.acceptStock) || !!info?.acceptCut;
  };
  const decisionsCount = cuttingBatch.length + stockDecisions.length;

  return {
    location,
    navigate,
    qc,
    user,
    canReturn,
    canIssue,
    canOverrideMaterial,
    canManage,
    prefill,
    selected,
    setSelected,
    substituteSkuId,
    setSubstituteSkuId,
    areaFilter,
    setAreaFilter,
    taskFilter,
    setTaskFilter,
    statusFilter,
    setStatusFilter,
    search,
    setSearch,
    queueView,
    setQueueView,
    pickQueueView,
    cardTab,
    setCardTab,
    cardGroup,
    setCardGroup,
    manualOpen,
    setManualOpen,
    result,
    setResult,
    lastIssued,
    setLastIssued,
    cuttingSession,
    setCuttingSession,
    cuttingBatch,
    setCuttingBatch,
    cuttingBatchOpen,
    setCuttingBatchOpen,
    slipModalOpen,
    setSlipModalOpen,
    slipTaskId,
    setSlipTaskId,
    addToCuttingBatch,
    removeFromCuttingBatch,
    stockDecisions,
    setStockDecisions,
    addStockDecision,
    removeStockDecision,
    decidedLineIds,
    executingAll,
    setExecutingAll,
    lineInfoMap,
    setLineInfoMap,
    reportGroupInfos,
    manualPickerTarget,
    setManualPickerTarget,
    detailRow,
    setDetailRow,
    executeAllDecisions,
    manualSkuId,
    setManualSkuId,
    manualArea,
    setManualArea,
    manualForm,
    manualDonor,
    setManualDonor,
    manualElsewhere,
    setManualElsewhere,
    shortageModalOpen,
    setShortageModalOpen,
    shortageForm,
    occurredAt,
    setOccurredAt,
    skusQuery,
    widthAnalogsQuery,
    widthAnalogGroups,
    manualSkusQuery,
    tasksQuery,
    areasQuery,
    areaLabel,
    areaRequiresDailyPlan,
    areaOptions,
    taskOptions,
    sitesQuery,
    warehousesQuery,
    homeWarehouseFor,
    confirmIfWrongWarehouse,
    manualIssuedQuery,
    manualIssuedUnits,
    today,
    activeLines,
    assignmentRows,
    linesWithTodayAssignment,
    weekRows,
    matchesFilter,
    filteredAssignmentRows,
    filteredWeekRows,
    overdueCount,
    todayCount,
    weekRowsNeedingMaterial,
    areasWaiting,
    pendingReturnByTask,
    selectedSku,
    selectedStripWidth,
    selectedNeededLengthM,
    findMutation,
    substituteSku,
    substituteAvailableQuery,
    availableQuery,
    exactMatch,
    neededM2,
    availableM2,
    shortfallM2,
    shopFloorRequestMutation,
    openShortageModal,
    directMutation,
    finishSingleCut,
    remainderSuggestion,
    placeRemainderMutation,
    finishAndReset,
    manualSku,
    manualAvailableQuery,
    manualDirectMutation,
    manualFindMutation,
    closeLineMutation,
    issuedNoteForLine,
    lineActuals,
    UnitLink,
    rowStatusKind,
    renderStatusPill,
    needTableRows,
    manualTableRows,
    tableRows,
    findStockSiblingCandidates,
    filteredTableRows,
    cuttingRows,
    cuttingGroups,
    groupRowsByRowKey,
    printFactorySlip,
    openDetail,
    closeDetail,
    whenLabel,
    inCardTab,
    acceptRow,
    readyRow,
    decisionsCount,
  };
}

export type IssueState = ReturnType<typeof useIssue>;
