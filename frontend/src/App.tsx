import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { apiErrorMessage, apiErrorTitle } from './api/errors';
import { Layout } from './components/Layout/Layout';
import { SectionErrorBoundary } from './components/ErrorBoundary';
import { Login } from './pages/Login';
import { MyWork } from './pages/MyWork';
import { Settings } from './pages/Settings';
import { Dashboard } from './pages/Dashboard/Dashboard';
import { DirectorDashboard } from './pages/Dashboard/DirectorDashboard';
import { OrdersList } from './pages/Orders/OrdersList';
import { OrdersInbox } from './pages/Orders/OrdersInbox';
import { ProductionPlan, ShopFloor } from './pages/Production';
import { Sites } from './pages/Sites';
import { ContractorWork } from './pages/Production/ContractorWork';
import { Warehouse } from './pages/Warehouse';
import { Finance } from './pages/Finance';
import { Purchases } from './pages/Purchases';
import { Prices } from './pages/Prices';
import { Integration } from './pages/Integration';
import { Specifications } from './pages/Specifications';
import { Pipeline } from './pages/Sales/Pipeline';

const queryClient = new QueryClient({
  /**
   * Ни одна мутация не падает молча (04.09.2026).
   *
   * Перехватчик axios обрабатывает только 401 — всё остальное он просто
   * пробрасывает дальше. Из 64 мутаций свой onError имели 36; остальные
   * 28 при отказе сервера не показывали ничего. На складе и в цеху это
   * опаснее пустого экрана: человек жмёт «Изготовлено», ничего не
   * происходит, и он уверен, что отметка прошла.
   *
   * Обработчик на уровне кэша ловит ВСЕ мутации, включая те, которых
   * ещё нет. Мутации со своим onError он пропускает — иначе на них
   * выскакивало бы два сообщения подряд.
   */
  mutationCache: new MutationCache({
    onError: (error, _vars, _ctx, mutation) => {
      if (mutation.options.onError) return;
      notifications.show({
        title: apiErrorTitle(error),
        message: apiErrorMessage(error),
        color: 'danger',
      });
    },
  }),
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    mutations: {
      // Мутация не повторяется сама: повтор «отметить изготовленным»
      // или «провести оплату» может задвоить запись
      retry: 0,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          {/* Граница ошибок на корне: что бы ни упало в оболочке (шапка,
              меню), человек увидит сообщение, а не пустой холст */}
          <Route path="/" element={<SectionErrorBoundary><Layout /></SectionErrorBoundary>}>
            {/* «Моя работа» — точка входа: очередь своей роли, а не общий дашборд */}
            <Route index element={<MyWork />} />
            <Route path="settings" element={<Settings />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="dashboard/director" element={<DirectorDashboard />} />
            <Route path="orders" element={<OrdersList />} />
            <Route path="orders/inbox" element={<OrdersInbox />} />
            <Route path="sites" element={<Sites />} />
            <Route path="production" element={<ProductionPlan />} />
            <Route path="production/kanban" element={<ShopFloor />} />
            <Route path="production/contractors" element={<ContractorWork />} />
            <Route path="sales/pipeline" element={<Pipeline />} />
            <Route path="warehouse" element={<Warehouse />} />
            <Route path="purchases" element={<Purchases />} />
            <Route path="prices" element={<Prices />} />
            <Route path="finance" element={<Finance />} />
            <Route path="specs" element={<Specifications />} />
            <Route path="integration" element={<Integration />} />
            <Route path="audit" element={<div className="p-8">Аудит (заглушка)</div>} />
            {/* Незнакомый адрес — молча на «Мою работу», а не белый экран */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
