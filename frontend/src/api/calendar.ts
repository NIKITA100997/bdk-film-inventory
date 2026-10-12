import { apiClient } from "./client";

/** Производственный календарь (12.10): исключения из пятидневки — праздник,
 * рабочая суббота, нерабочий день; для всех участков (area = null) или одного. */
export interface CalendarDay {
  id: number;
  day: string;
  area: string | null;
  area_name: string | null;
  is_workday: boolean;
  note: string | null;
}

export const listCalendarDays = async (dateFrom: string, dateTo: string): Promise<CalendarDay[]> =>
  (await apiClient.get<CalendarDay[]>("/production-calendar", { params: { date_from: dateFrom, date_to: dateTo } })).data;

export const setCalendarDay = async (payload: { day: string; area: string | null; is_workday: boolean; note: string | null }) =>
  (await apiClient.put<CalendarDay | null>("/production-calendar", payload)).data;

export const deleteCalendarDay = async (id: number): Promise<void> => {
  await apiClient.delete(`/production-calendar/${id}`);
};

export const rescheduleOpenOrders = async (): Promise<{ orders: number; late: number }> =>
  (await apiClient.post<{ orders: number; late: number }>("/production-calendar/reschedule")).data;
