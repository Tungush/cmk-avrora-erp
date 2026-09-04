import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Drawer, Text, Group, Badge } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { OrderDetail } from '../../pages/Orders/OrderDetail';

/** Секция карточки, к которой прокрутить при открытии */
export type OrderCardFocus = 'stages' | 'money' | 'cost' | 'supply' | 'lines';

interface OrderCardApi {
  /** Открыть карточку заказа поверх текущего экрана */
  open: (orderId: string, focus?: OrderCardFocus) => void;
  close: () => void;
  openedId: string | null;
  focus: OrderCardFocus | null;
  /**
   * Экран сам показывает карточку панелью и просит не открывать шторку.
   * Возвращает функцию отписки — раздел обязан её вызвать при уходе,
   * иначе шторка останется выключенной на всём приложении.
   */
  claimInline: () => () => void;
}

const Ctx = createContext<OrderCardApi | null>(null);

/**
 * Карточка заказа как общая шторка (решение 23.08.2026).
 *
 * Заказ — центр системы, и дойти до него нужно из любого раздела. Раньше
 * карточка жила в локальном состоянии реестра заказов: номер заказа был
 * нарисован в 21 месте, а кликабелен ровно один.
 *
 * Состояние держится в адресе (`?order=…&focus=…`), а не в useState:
 * ссылку можно переслать, «назад» закрывает карточку. Но это именно
 * ШТОРКА поверх экрана, а не отдельная страница — мастер в цеху не должен
 * терять очередь переделов, а плановик — неделю плана.
 */
export function OrderCardProvider({ children }: { children: React.ReactNode }) {
  const [params, setParams] = useSearchParams();
  const isMobile = useMediaQuery('(max-width: 767px)');

  const openedId = params.get('order');
  const focus = (params.get('focus') as OrderCardFocus | null) ?? null;

  /**
   * Реестр заказов показывает паспорт постоянной панелью справа, как в
   * эталоне: список слева, живая карточка рядом. Шторка поверх того же
   * содержимого была бы вторым его экземпляром, поэтому раздел
   * «забирает» карточку себе, а провайдер перестаёт рисовать шторку.
   * Счётчик, а не флаг: два хоста подряд при переходе между разделами
   * монтируются раньше, чем размонтируется предыдущий.
   */
  const [inlineHosts, setInlineHosts] = useState(0);
  const claimInline = useCallback(() => {
    setInlineHosts((n) => n + 1);
    return () => setInlineHosts((n) => Math.max(0, n - 1));
  }, []);

  const open = useCallback((orderId: string, f?: OrderCardFocus) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('order', orderId);
      if (f) next.set('focus', f); else next.delete('focus');
      return next;
    });
  }, [setParams]);

  const close = useCallback(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('order');
      next.delete('focus');
      return next;
    }, { replace: true });
  }, [setParams]);

  const api = useMemo<OrderCardApi>(
    () => ({ open, close, openedId, focus, claimInline }),
    [open, close, openedId, focus, claimInline],
  );

  return (
    <Ctx.Provider value={api}>
      {children}
      <Drawer
        opened={Boolean(openedId) && inlineHosts === 0}
        onClose={close}
        position="right"
        size={isMobile ? '100%' : 'xl'}
        title={<Text fw={700}>Карточка заказа</Text>}
        padding="md"
        keepMounted={false}
      >
        {openedId && <OrderDetail id={openedId} onClose={close} focus={focus} />}
      </Drawer>
    </Ctx.Provider>
  );
}

export function useOrderCard(): OrderCardApi {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useOrderCard вызван вне OrderCardProvider — провайдер стоит в Layout');
  }
  return ctx;
}

/**
 * Номер заказа как ссылка на карточку. Ставится везде, где раньше номер
 * был мёртвым текстом — чтобы из любого экрана можно было провалиться
 * в заказ и вернуться туда, где был.
 */
export function OrderRef({
  id, number, focus, size = 'sm', bold = true, badge,
}: {
  id: string;
  number: string;
  focus?: OrderCardFocus;
  size?: string;
  bold?: boolean;
  badge?: React.ReactNode;
}) {
  const { open } = useOrderCard();
  return (
    <Group gap={6} wrap="nowrap" style={{ display: 'inline-flex' }}>
      <Text
        component="button"
        type="button"
        onClick={(e: React.MouseEvent) => { e.stopPropagation(); open(id, focus); }}
        size={size}
        fw={bold ? 700 : 500}
        ff="monospace"
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {number}
      </Text>
      {badge}
    </Group>
  );
}

/** Заказ из Excel-миграции: данные исторические, их всё равно снесут */
export function ArchivedHint() {
  return (
    <Badge color="gray" variant="light" radius="xl" size="md" fz={12}>
      исторические данные из Excel
    </Badge>
  );
}

/**
 * Раздел показывает карточку заказа панелью на месте, а не шторкой.
 *
 * @param active выключается на узком экране: два столбца там не
 *   помещаются, и карточка обязана вернуться шторкой — иначе заказ
 *   нельзя будет открыть вовсе.
 */
export function useInlineOrderCard(active = true) {
  const { claimInline } = useOrderCard();
  useEffect(() => {
    if (!active) return;
    return claimInline();
  }, [claimInline, active]);
}
