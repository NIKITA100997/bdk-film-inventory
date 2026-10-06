import { type ReactNode } from "react";
import {
  Space,
} from "antd";
import { type NeedTableRow, findSku } from "./model";
import { GroupDecisionPanel } from "./GroupPanels";
import SelectedRowPanel from "./SelectedRowPanel";
import { type IssueState } from "./useIssue";

/** Тело окна «Подробнее» строки очереди (06.10: из Issue.tsx). */
export default function DetailModalBody({ s, row }: { s: IssueState; row: NeedTableRow }): ReactNode {
  const { setManualPickerTarget, skusQuery, areasQuery, groupRowsByRowKey } = s;

    const groupRows = groupRowsByRowKey.get(row.key) ?? [];
    if (groupRows.length > 1) {
      // Раздел про разбор задания единой таблицей — групповой план (донор
      // сразу на несколько строк) и общая панель по ЭТОЙ конкретной
      // строке (точное совпадение/донор/замена материала/своя ширина
      // через CuttingForm) показываются ВМЕСТЕ, не взаимоисключающе —
      // так же, как раньше банер и карточка строки сосуществовали.
      return (
        <Space direction="vertical" style={{ width: "100%" }} size="middle">
          <GroupDecisionPanel
            sku={findSku(skusQuery.data, row.line.material, row.line.color, row.line.thickness)}
            rows={groupRows}
            cutOnSite={!!areasQuery.data?.find((a) => a.code === row.task.area)?.film_cut_on_site}
            onOpenManualPicker={() => {
              const sku = findSku(skusQuery.data, row.line.material, row.line.color, row.line.thickness);
              if (sku) setManualPickerTarget({ sku, rows: groupRows });
            }}
          />
          {<SelectedRowPanel s={s} />}
        </Space>
      );
    }
    return <SelectedRowPanel s={s} />;

}
