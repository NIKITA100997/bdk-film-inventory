import Receive from "./Receive";
import Issue from "./Issue";

/** Форма приёмки рулонов плёнки внутри рабочего места плёнки. */
export function ReceiveHub() {
  return <Receive />;
}

/** Выдача, нарезка и возврат рулонов плёнки. ПФ учитывается в складском разделе ПФ. */
export function IssueHub() {
  return <Issue />;
}
