import { Checkbox, DatePicker, Input, Radio, Select, Space } from "antd";
import type dayjs from "dayjs";

export type StatusFilter = "all" | "in_work" | "urgent" | "deficit";

export interface MonitorFilterBarProps {
  q: string;
  onSearchChange: (q: string) => void;
  statusFilter?: StatusFilter;
  onStatusFilterChange?: (s: StatusFilter) => void;
  showDone: boolean;
  onShowDoneChange: (show: boolean) => void;
  orderIds: number[];
  onOrderIdsChange: (ids: number[]) => void;
  orderOptions: { value: number; label: string }[];
  selectedSeries: string[];
  onSelectedSeriesChange: (series: string[]) => void;
  itemOrSeriesOptions: { label: string; options: { value: string; label: string }[] }[];
  dateRange: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null;
  onDateRangeChange: (dates: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null) => void;
  compact?: boolean;
}

export default function MonitorFilterBar({
  q,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  showDone,
  onShowDoneChange,
  orderIds,
  onOrderIdsChange,
  orderOptions,
  selectedSeries,
  onSelectedSeriesChange,
  itemOrSeriesOptions,
  dateRange,
  onDateRangeChange,
  compact = false,
}: MonitorFilterBarProps) {
  return (
    <div
      style={{
        background: "#fafafa",
        padding: compact ? "6px 10px" : "8px 12px",
        borderRadius: 8,
        border: "1px solid #f0f0f0",
        marginBottom: 8,
      }}
    >
      <Space wrap size={[10, 8]} style={{ width: "100%", alignItems: "center" }}>
        <Input.Search
          allowClear
          placeholder="Счёт, клиент, серия, цвет..."
          style={{ width: 230 }}
          value={q}
          onChange={(e) => onSearchChange(e.target.value)}
        />

        {statusFilter && onStatusFilterChange && (
          <Radio.Group
            size="small"
            value={statusFilter}
            onChange={(e) => onStatusFilterChange(e.target.value)}
            optionType="button"
            buttonStyle="solid"
          >
            <Radio.Button value="all">Все</Radio.Button>
            <Radio.Button value="in_work">В работе</Radio.Button>
            <Radio.Button value="urgent">🔥 Горящие (≤2 дн)</Radio.Button>
            <Radio.Button value="deficit">Дефицит плёнки</Radio.Button>
          </Radio.Group>
        )}

        <Checkbox checked={showDone} onChange={(e) => onShowDoneChange(e.target.checked)}>
          показывать готовые
        </Checkbox>

        <Select
          mode="multiple"
          allowClear
          placeholder="Фильтр по заказам"
          style={{ minWidth: 180, maxWidth: 280 }}
          value={orderIds}
          onChange={onOrderIdsChange}
          optionFilterProp="label"
          maxTagCount="responsive"
          options={orderOptions}
        />

        <Select
          mode="multiple"
          allowClear
          placeholder="Изделие / Серия"
          style={{ minWidth: 180, maxWidth: 260 }}
          value={selectedSeries}
          onChange={onSelectedSeriesChange}
          optionFilterProp="label"
          maxTagCount="responsive"
          options={itemOrSeriesOptions}
        />

        <DatePicker.RangePicker
          placeholder={["Отгрузка с", "по"]}
          format="DD.MM"
          value={dateRange}
          onChange={(dates) => onDateRangeChange(dates as [dayjs.Dayjs | null, dayjs.Dayjs | null] | null)}
          style={{ width: 175 }}
          allowClear
        />
      </Space>
    </div>
  );
}
