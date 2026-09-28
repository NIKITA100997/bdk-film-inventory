import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { listPfReserves, type PartReserve } from "../api/pfDemand";

/** Резерв п/ф по деталям — один запрос на экран, общий кэш. */
export function usePfReserves(enabled = true): Map<number, PartReserve> {
  const query = useQuery({ queryKey: ["pf-demand", "reserves"], queryFn: listPfReserves, enabled });
  return useMemo(() => new Map((query.data ?? []).map((r) => [r.part_id, r])), [query.data]);
}
