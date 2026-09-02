import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Group, Text, Tooltip } from '@mantine/core';
import { Link } from 'react-router-dom';
import { dashboardApi } from '../../api/dashboard';

/**
 * Живые цифры завода в шапке (02.09.2026, замена значка «Онлайн»).
 *
 * «Онлайн» ничего не сообщал: он горел зелёным всегда, даже когда бэкенд
 * лежал, — место в самой заметной части экрана уходило на украшение.
 * Теперь там три числа, за которыми люди и приходят в систему, и каждое —
 * ссылка на свой раздел.
 *
 * Запрос лёгкий (одна сводка, обновление раз в 5 минут) и общий для всех
 * экранов: TanStack Query отдаёт его из кэша, второй раз в сеть не ходит.
 */
export function HeaderPulse() {
  const { data, isError } = useQuery({
    queryKey: ['workload-forecast'],
    queryFn: () => dashboardApi.getWorkloadForecast().then((r) => r.data),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });

  // Врать нечем: не отдалось или пришло не то — показываем пусто, а не
  // мнимый «Онлайн». Проверка формы обязательна: шапка живёт вне границы
  // ошибок раздела, и её падение гасит всё приложение целиком
  if (isError || !data || typeof data.activeOrders !== 'number') return null;

  const items = [
    {
      to: '/orders',
      label: 'в работе',
      value: data.activeOrders.toLocaleString('ru-RU'),
      hint: 'Активных заказов в производстве',
      tone: undefined as string | undefined,
    },
    {
      to: '/production',
      label: 'ч в очереди',
      value: Math.round(data.requiredHours).toLocaleString('ru-RU'),
      hint: `Труда по нормам на все активные заказы · мощность ${data.weeklyCapacityHours} ч в неделю`
        + (data.weeksOfBacklog != null ? ` · это ${Math.round(data.weeksOfBacklog)} нед` : ''),
      tone: undefined,
    },
    {
      to: '/specs',
      label: 'без норм',
      value: data.linesWithoutNorm.toLocaleString('ru-RU'),
      hint: `Позиций без норм труда из ${data.linesTotal.toLocaleString('ru-RU')} — себестоимость по ним встанет в ноль`,
      tone: data.linesWithoutNorm > 0 ? 'warn' : undefined,
    },
  ];

  return (
    <Group gap={0} wrap="nowrap" className="head-pulse" visibleFrom="md">
      {items.map((it) => (
        <Tooltip key={it.to} label={it.hint} openDelay={300} multiline w={280} withArrow>
          <Link to={it.to} className="head-pulse__item" data-tone={it.tone}>
            <Text component="span" className="head-pulse__value">{it.value}</Text>
            <Text component="span" className="head-pulse__label">{it.label}</Text>
          </Link>
        </Tooltip>
      ))}
    </Group>
  );
}
