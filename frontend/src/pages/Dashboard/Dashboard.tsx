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

export function Dashboard() {
  const { data: summary, isLoading } = useProductionSummary();
  // Палитра графиков — «горячий металл», валидирована на CVD и контраст
  const chart = {
    cat1: '#D9480F', cat2: '#0891B2',
    muted: 'rgba(215, 212, 204, 0.75)',
    grid: 'rgba(107, 103, 93, 0.14)',
    tick: '#6B675D',
  };
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
    labels: ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн'],
    datasets: [
      {
        label: 'План',
        data: [120, 150, 180, 190, 210, summary?.productionPlanFact?.planned ?? 0],
        backgroundColor: chart.muted,
        borderRadius: 6,
        borderSkipped: false,
      },
      {
        label: 'Факт',
        data: [115, 140, 175, 195, 205, summary?.productionPlanFact?.actual ?? 0],
        backgroundColor: chart.cat1,
        borderRadius: 6,
        borderSkipped: false,
      },
    ],
  }), [summary]);

  const lineData = useMemo(() => ({
    labels: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
    datasets: [
      {
        label: 'Дебиторка (млн ₸)',
        data: [12, 11.5, 13, 12.8, 11.2, 10.5, (summary?.receivablesTotal ?? 0) / 1000000],
        borderColor: chart.cat1,
        backgroundColor: 'rgba(217, 72, 15, 0.07)',
        fill: true,
        tension: 0.4,
        pointBackgroundColor: chart.cat1,
        pointRadius: 3,
        borderWidth: 2.5,
      },
    ],
  }), [summary]);

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
          font: { size: 11, family: 'Inter, sans-serif' },
          color: chart.tick,
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          font: { size: 11, family: 'Inter, sans-serif' },
          color: chart.tick,
        },
      },
      y: {
        grid: { color: chart.grid },
        ticks: {
          font: { size: 11, family: 'Inter, sans-serif' },
          color: chart.tick,
        },
      },
    },
  }), []);

  if (isLoading) {
    return (
      <Stack gap="lg">
        <Skeleton height={160} radius="lg" />
        <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="lg">
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

      <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="lg">
        <KpiCard
          title="План производства"
          value={`${summary.productionPlanFact.actual} / ${summary.productionPlanFact.planned}`}
          subtitle="Выполнение плана (шт)"
          icon={<IconPackage size={20} />}
          trend={{ value: 4.2, label: 'к прошлому месяцу' }}
        />
        <KpiCard
          title="Загрузка цеха"
          value={`${loadPct.toFixed(1)}%`}
          subtitle={`${summary.workshopLoadHours.used} / ${summary.workshopLoadHours.total} ч.`}
          icon={<IconCpu size={20} />}
          trend={{ value: -1.5, label: 'к прошлой неделе' }}
        />
        {canFinance && (
          <KpiCard
            title="Дебиторская задолженность"
            value={formatCurrency(summary.receivablesTotal)}
            subtitle="Общая сумма задолженности"
            icon={<IconBuildingBank size={20} />}
            trend={{ value: 12.4, label: 'рост задолженности' }}
          />
        )}
        <KpiCard
          title="Обеспеченность ГП"
          value={`${fgPct.toFixed(1)}%`}
          subtitle={`${summary.fgStockVsNorm.inStock} / ${summary.fgStockVsNorm.norm} шт.`}
          icon={<IconActivity size={20} />}
        />
      </SimpleGrid>

      {/* Ролевые виджеты (§2.4): состав определяется правами на сервере */}
      <RoleWidgets />

      <SimpleGrid cols={{ base: 1, lg: 2 }} spacing="lg">
        <Card withBorder padding="lg" radius="lg">
          <Group justify="space-between" mb="lg">
            <Stack gap={4}>
              <Text fw={800} size="lg">Выполнение плана</Text>
              <Text size="xs" c="dimmed">Плановые и фактические объёмы</Text>
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
              <Text fw={800} size="lg">Дебиторская задолженность</Text>
              <Text size="xs" c="dimmed">Тренд по дням недели</Text>
            </Stack>
            <Group gap="xs">
              <ThemeIcon color="success" size="sm" variant="light" radius="xl">
                <IconTrendingUp size={14} />
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
