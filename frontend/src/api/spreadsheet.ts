import api from './client';

export const spreadsheetApi = {
  getLatestImport: () => api.get('/spreadsheet/imports/latest'),
  listSheets: () => api.get('/spreadsheet/sheets'),
  getSheet: (name: string) => api.get(`/spreadsheet/sheets/${encodeURIComponent(name)}`),
  getRows: (name: string, params?: { page?: number; pageSize?: number; search?: string; includeEmpty?: boolean }) =>
    api.get(`/spreadsheet/sheets/${encodeURIComponent(name)}/rows`, { params }),
};
