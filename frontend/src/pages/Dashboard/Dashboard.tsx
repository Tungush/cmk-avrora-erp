import React, { useMemo } from 'react';
import {
  Card,
  Stack,
  Group,
  Text,
  Badge,
  SimpleGrid,
  Box,
  Skeleton,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconPackage,
  IconCpu,
  IconBuildingBank,
  IconActivity,
  IconCheck,
  IconTrendingUp,
} from '@tabler/icons-react';
import { useProductionSummary } from '../../hooks/useDashboard';
import { useQuery } from '@tanstack/react-query';
import api from '../../api/client';
import { useAuthStore } from '../../store/auth';
import { KpiCard } from '../../components/KpiCard';
import { PriceReviewsPanel } from '../../components/PriceReviewsPanel';
import { RoleWidgets } from '../../components/RoleWidgets';
import { formatCurrency } from '../../utils/formatters';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title as ChartTitle,
  Tooltip,
  Legend,
  PointElement,
  LineElement,
  Filler,
} from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ChartTitle,
  Tooltip,
  Legend,
  PointElement,
  LineElement,
  Filler,
);

/**
 * Значение токена палитры строкой (03.09.2026).
 *
 * Chart.js рисует на canvas и `var(--s-…)` не понимает — цвет ему нужен
 * готовым. Достаём его из :root, чтобы график менялся вместе с палитрой,
 * а не жил на своих сырых hex, как раньше. `alpha` нужен волосяной сетке
 * и заливке под линией: у токенов прозрачных вариантов нет.
 */
function tokenValue(name: string, alpha?: number): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!raw) return undefined;
  if (alpha == null) return raw;
  const hex = raw.replace('#', '');
  if (hex.length !== 6) return raw;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function Dashboard() {
  const { data: summary, isLoading } = useProductionSummary();
  // Ряды графиков — из базы. Раньше здесь были захардкоженные массивы:
  // ровный тренд, которого не существовало
  const { data: series } = useQuery({
    queryKey: ['dashboard', 'monthly-series'],
    queryFn: () => api.get<{ months: Array<{ label: string; ordersIn: number; planned: number; shipped: number }> }>('/dashboards/monthly-series').then((r) => r.data),
  });
  const months = series?.months ?? [];
  // Палитра графиков берётся из токенов (03.09.2026). Здесь были сырые
  // hex: терракота #D9480F и бирюза #0891B2 — бирюзы нет ни в теме, ни в
  // палитре, а вторая категория к тому же нигде не рисовалась.
  const chart = useMemo(() => ({
    cat1: tokenValue('--s-attention-fill'),
    cat1Wash: tokenValue('--s-attention-fill', 0.07),
    muted: tokenValue('--s-line'),
    grid: tokenValue('--s-text-quiet', 0.14),
    tick: tokenValue('--s-text-quiet'),
  }), []);
  const user = useAuthStore((state) => state.user);
  const can = useAuthStore((state) => state.can);
  // Финансовые KPI видит только коммерция (§2.4: инженер не видит выручку)
  const canFinance = can('read', 'payment.core');

  const loadPct = useMemo(() => {
    if (!summary) return 0;
    return summary.workshopLoadHours.total > 0
      ? (summary.workshopLoadHours.used / summary.workshopLoadHours.total) * 100
      : 0;
  }, [summary]);

  const fgPct = useMemo(() => {
    if (!summary) return 0;
    return summary.fgStockVsNorm.norm > 0
      ? (summary.fgStockVsNorm.inStock / summary.fgStockVsNorm.norm) * 100
      : 0;
  }, [summary]);

  const barData = useMemo(() => ({
    labels: months.map((m) => m.label),
    datasets: [
      {
        label: 'План отгрузок',
        data: months.map((m) => m.planned),
        backgroundColor: chart.muted,
        borderRadius: 6,
        borderSkipped: false,
      },
      {
        label: 'Отгружено',
        data: months.map((m) => m.shipped),
        backgroundColor: chart.cat1,
        borderRadius: 6,
        borderSkipped: false,
      },
    ],
  }), [months, chart]);

  const lineData = useMemo(() => ({
    labels: months.map((m) => m.label),
    datasets: [
      {
        label: 'Поступило заказов',
        data: months.map((m) => m.ordersIn),
        borderColor: chart.cat1,
        backgroundColor: chart.cat1Wash,
        fill: true,
        tension: 0.4,
        pointBackgroundColor: chart.cat1,
        pointRadius: 3,
        borderWidth: 2.5,
      },
    ],
  }), [months, chart]);

  const chartOptions = useMemo(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        position: 'bottom' as const,
        labels: {
          usePointStyle: true,
          boxWidth: 6,
          padding: 16,
          font: { size: 11, family: 'Golos Text, Manrope Variable, sans-serif' },
          color: chart.tick,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          font: { size: 11, family: 'Golos Text, Manrope Variable, sans-serif' },
          color: chart.tick,
        },
      },
      y: {
        grid: { color: chart.grid },
        ticks: {
          font: { size: 11, family: 'Golos Text, Manrope Variable, sans-serif' },
          color: chart.tick,
        },
      },
    },
  }), [chart]);

  if (isLoading) {
    return (
      <Stack gap="lg">
        <Skeleton height={160} radius="lg" />
        <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }} spacing="lg">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} height={140} radius="lg" />
          ))}
        </SimpleGrid>
        <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
          <Skeleton height={320} radius="lg" />
          <Skeleton height={320} radius="lg" />
        </SimpleGrid>
      </Stack>
    );
  }

  if (!summary) {
    return (
      <Box ta="center" py={100}>
        <Text c="dimmed" fw={600}>Ошибка загрузки данных дашборда</Text>
      </Box>
    );
  }

  const greeting = user?.email?.split('@')[0] || 'Оператор';

  return (
    <Stack gap="lg">
      <PriceReviewsPanel />
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="md">
        <Stack gap={4}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.08em' }}>
            Панель управления
          </Text>
          <Title order={2} fw={700} style={{ letterSpacing: '-0.01em' }}>
            Добрый день, {greeting}
          </Title>
        </Stack>
        <Text size="sm" c="dimmed" ff="monospace">
          {new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </Text>
      </Group>

      <SimpleGrid cols={{ base: 1, sm: 2, xl: 4 }} spacing="lg">
        <KpiCard
          title="План производства"
          value={`${summary.productionPlanFact.actual} / ${summary.productionPlanFact.planned}`}
          subtitle="Выполнение плана (шт)"
          icon={<IconPackage aria-hidden size={20} />}
        />
        <KpiCard
          title="Загрузка цеха"
          value={`${loadPct.toFixed(1)}%`}
          subtitle={`${summary.workshopLoadHours.used} / ${summary.workshopLoadHours.total} ч.`}
          icon={<IconCpu aria-hidden size={20} />}
        />
        {canFinance && (
          <KpiCard
            title="Дебиторская задолженность"
            value={formatCurrency(summary.receivablesTotal)}
            subtitle="Общая сумма задолженности"
            icon={<IconBuildingBank aria-hidden size={20} />}
          />
        )}
        <KpiCard
          title="Обеспеченность ГП"
          value={`${fgPct.toFixed(1)}%`}
          subtitle={`${summary.fgStockVsNorm.inStock} / ${summary.fgStockVsNorm.norm} шт.`}
          icon={<IconActivity aria-hidden size={20} />}
        />
      </SimpleGrid>

      {/* Ролевые виджеты (§2.4): состав определяется правами на сервере */}
      <RoleWidgets />

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <Card withBorder padding="lg" radius="lg">
          <Group justify="space-between" mb="lg">
            <Stack gap={4}>
              <Text fw={800} size="lg">Отгрузки: план и факт</Text>
              <Text size="xs" c="dimmed">По месяцам, из дат заказов</Text>
            </Stack>
            <Badge variant="light" color="gray" size="lg" radius="xl">
              2026
            </Badge>
          </Group>
          <Box h={280}>
            <Bar data={barData} options={chartOptions} />
          </Box>
        </Card>

        {canFinance && (
        <Card withBorder padding="lg" radius="lg">
          <Group justify="space-between" mb="lg">
            <Stack gap={4}>
              <Text fw={800} size="lg">Поступление заказов</Text>
              <Text size="xs" c="dimmed">Заявок в месяц, последние полгода</Text>
            </Stack>
            <Group gap="xs">
              <ThemeIcon color="success" size="sm" variant="light" radius="xl">
                <IconTrendingUp aria-hidden size={16} />
              </ThemeIcon>
              <Text size="xs" fw={800} c="success.7">KZT</Text>
            </Group>
          </Group>
          <Box h={280}>
            <Line
              data={lineData}
              options={{
                ...chartOptions,
                plugins: { ...chartOptions.plugins, legend: { display: false } },
              }}
            />
          </Box>
        </Card>
        )}
      </SimpleGrid>
    </Stack>
  );
}
