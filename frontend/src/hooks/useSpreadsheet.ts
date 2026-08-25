import { useQuery } from '@tanstack/react-query';
import { spreadsheetApi } from '../api/spreadsheet';

export function useSpreadsheetSheets() {
  return useQuery({
    queryKey: ['spreadsheet', 'sheets'],
    queryFn: () => spreadsheetApi.listSheets().then((r) => r.data),
  });
}

export function useSpreadsheetRows(
  sheetName: string,
  params?: { page?: number; pageSize?: number; includeEmpty?: boolean; search?: string },
) {
  return useQuery({
    queryKey: ['spreadsheet', 'rows', sheetName, params],
    queryFn: () => spreadsheetApi.getRows(sheetName, params).then((r) => r.data),
    enabled: !!sheetName,
  });
}
