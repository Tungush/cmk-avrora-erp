import React from 'react';
import { Group, Stack, Text } from '@mantine/core';

/**
 * Знак ЦМК АВРОРА (24.08.2026).
 *
 * Буква «А» — это силуэт фермы, которую завод варит каждый день:
 * две ноги под конёк, центральная стойка, затяжка. Знак не «нарисован
 * под металл» — он и есть чертёж изделия. Узлы обозначены точками,
 * как на конструкторской схеме.
 *
 * Правила: один цвет на знак (раскалённый металл или белый на тёмном),
 * никаких подложек-квадратиков — знак стоит сам, как стоит ферма.
 */
export function LogoMark({
  size = 36, color = 'var(--brand-6)', strokeWidth = 4.6,
}: { size?: number; color?: string; strokeWidth?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      aria-label="ЦМК АВРОРА"
      role="img"
    >
      {/* Ноги фермы */}
      <path d="M24 7 L7 41 M24 7 L41 41" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      {/* Затяжка */}
      <path d="M13.5 29 L34.5 29" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      {/* Центральная стойка — шпренгель */}
      <path d="M24 7 L24 29" stroke={color} strokeWidth={strokeWidth * 0.72} strokeLinecap="round" />
      {/* Узлы — как на чертеже */}
      <circle cx="24" cy="7" r="2.6" fill={color} />
      <circle cx="13.5" cy="29" r="2.2" fill={color} />
      <circle cx="34.5" cy="29" r="2.2" fill={color} />
    </svg>
  );
}

/** Полный логотип: знак + набор. Тёмная и светлая версии */
export function LogoLockup({
  onDark = false, markSize = 38,
}: { onDark?: boolean; markSize?: number }) {
  const primary = onDark ? '#FFFFFF' : 'var(--gray-9)';
  const accent = onDark ? '#E16323' : 'var(--brand-6)';
  return (
    <Group gap={12} wrap="nowrap" align="center">
      <LogoMark size={markSize} color={accent} />
      <Stack gap={1}>
        <Text
          fw={800}
          size="md"
          lh={1}
          style={{ letterSpacing: '0.02em', color: primary }}
        >
          АВРОРА
        </Text>
        <Text
          size="xs"
          fw={600}
          lh={1}
          style={{ letterSpacing: '0.34em', fontSize: 9, color: onDark ? 'rgba(255,255,255,0.55)' : 'var(--gray-5)' }}
        >
          ЦМК·ERP
        </Text>
      </Stack>
    </Group>
  );
}
