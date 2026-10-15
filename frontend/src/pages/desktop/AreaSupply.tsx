import SectionTabs from "../../components/SectionTabs";
import AreaRequestsPanel from "../../components/areaSupply/AreaRequestsPanel";
import AreaNormsPanel from "../../components/areaSupply/AreaNormsPanel";
import { useTabTitle } from "../../layout/tabTitle";

/** Заявки участков и неснижаемый остаток (15.10) — одно для плёнки, п/ф и
 * материалов: участок просит, склад выдаёт; ниже нормы — пополнить. */
export default function AreaSupply() {
  useTabTitle("Заявки участков");
  return (
    <SectionTabs
      title="Заявки участков"
      sections={[
        { key: "requests", label: "Заявки", children: <AreaRequestsPanel /> },
        { key: "norms", label: "Неснижаемый остаток", children: <AreaNormsPanel /> },
      ]}
    />
  );
}
