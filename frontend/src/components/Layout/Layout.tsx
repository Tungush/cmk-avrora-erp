import React from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { AppShell, Box } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useAuthStore } from '../../store/auth';

export function Layout() {
  const token = useAuthStore((state) => state.token);
  const [mobileOpened, { toggle, close }] = useDisclosure();

  if (!token) {
    return <Navigate to="/login" replace />;
  }

  return (
    <AppShell
      header={{ height: 64 }}
      navbar={{ width: 260, breakpoint: 'sm', collapsed: { mobile: !mobileOpened } }}
      padding={{ base: 16, md: 24 }}
      bg="var(--app-bg)"
    >
      <AppShell.Header withBorder={false} bg="var(--app-surface)" style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}>
        <TopBar onToggleMobile={toggle} />
      </AppShell.Header>

      <AppShell.Navbar p="md" bg="var(--app-surface)" withBorder>
        <Sidebar onNavigate={close} />
      </AppShell.Navbar>

      <AppShell.Main>
        {/* min-width:0 — иначе широкие таблицы растягивают main и ломают сетку */}
        <Box style={{ minWidth: 0, maxWidth: '100%' }}>
          <Outlet />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
