import { Modal, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { getUnit, type MaterialUnit } from "../../api/units";
import { getPartUnit, type PartUnit } from "../../api/partUnits";
import LotOperationModal from "./LotOperationModal";
import { lotFromPartUnit, lotFromUnit, type LotOp } from "./lotOps";

/** Единое окно операции, когда у экрана есть только вид и номер партии
 * (журнал движений, поиск): сначала загружает рулон или партию п/ф. */
export default function LotOperationById({
  kind,
  id,
  op,
  onClose,
  onDone,
}: {
  kind: "plenka" | "pf";
  id: number;
  op: LotOp;
  onClose: () => void;
  onDone?: (updated: MaterialUnit | PartUnit) => void;
}) {
  const q = useQuery({
    queryKey: ["lot-by-id", kind, id],
    queryFn: async () => (kind === "plenka" ? lotFromUnit(await getUnit(id)) : lotFromPartUnit(await getPartUnit(id))),
  });
  if (!q.data)
    return (
      <Modal open footer={null} onCancel={onClose} title={kind === "plenka" ? `Рулон №${id}` : `Партия п/ф №${id}`}>
        {q.isError ? "Партия не найдена" : <Spin />}
      </Modal>
    );
  return <LotOperationModal lot={q.data} op={op} onClose={onClose} onDone={onDone} />;
}
