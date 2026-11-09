import { useState } from "react";
import { Input } from "antd";
import { useNavigate } from "react-router-dom";
import { runUnitOrMaterialSearch } from "../utils/unitSearch";

export function SearchBox() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  return (
    <Input.Search
      placeholder="Номер (рулон, партия, задание, заказ) или материал…"
      enterButton="Найти"
      style={{ width: 380, maxWidth: "100%" }}
      value={q}
      onChange={(e) => setQ(e.target.value)}
      onSearch={(v) => runUnitOrMaterialSearch(v, navigate)}
    />
  );
}

export default SearchBox;
