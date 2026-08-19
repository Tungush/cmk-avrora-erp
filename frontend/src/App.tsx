import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './components/Layout/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard/Dashboard';
import { OrdersList } from './pages/Orders/OrdersList';
import { ProductionPlan, ShopFloor } from './pages/Production';
import { Warehouse } from './pages/Warehouse';
import { Finance } from './pages/Finance';
import { Catalog } from './pages/Catalog';
import { Integration } from './pages/Integration';
import { Specifications } from './pages/Specifications';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="orders" element={<OrdersList />} />
            <Route path="production" element={<ProductionPlan />} />
            <Route path="production/kanban" element={<ShopFloor />} />
            <Route path="warehouse" element={<Warehouse />} />
            <Route path="finance" element={<Finance />} />
            <Route path="specs" element={<Specifications />} />
            <Route path="catalog" element={<Catalog />} />
            <Route path="integration" element={<Integration />} />
            <Route path="audit" element={<div className="p-8">Аудит (заглушка)</div>} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
