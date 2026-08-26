import React, { createContext, useCallback, useContext, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Drawer, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { ReceiptDetail } from '../../pages/Warehouse/ReceiptDetail';

interface ReceiptCardApi {
  open: (docId: string) => void;
  close: () => void;
  openedId: string | null;
}

const Ctx = createContext<ReceiptCardApi | null>(null);

/**
 * Карточка прихода на склад (ДО) — та же шторка, что и у заказа
 * (`OrderCardProvider`), только свой параметр в адресе (`?receipt=…`),
 * чтобы обе карточки могли быть открыты независимо друг от друга.
 * Решение пользователя 25.08.2026: «у каждого поступления будет своя
 * карточка сделки».
 */
export function ReceiptCardProvider({ children }: { children: React.ReactNode }) {
  const [params, setParams] = useSearchParams();
  const isMobile = useMediaQuery('(max-width: 767px)');

  const openedId = params.get('receipt');

  const open = useCallback((docId: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('receipt', docId);
      return next;
    });
  }, [setParams]);

  const close = useCallback(() => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('receipt');
      return next;
    }, { replace: true });
  }, [setParams]);

  const api = useMemo<ReceiptCardApi>(() => ({ open, close, openedId }), [open, close, openedId]);

  return (
    <Ctx.Provider value={api}>
      {children}
      <Drawer
        opened={Boolean(openedId)}
        onClose={close}
        position="right"
        size={isMobile ? '100%' : 'xl'}
        title={<Text fw={700}>Заказ поставщику</Text>}
        padding="md"
        keepMounted={false}
      >
        {openedId && <ReceiptDetail id={openedId} onClose={close} />}
      </Drawer>
    </Ctx.Provider>
  );
}

export function useReceiptCard(): ReceiptCardApi {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error('useReceiptCard вызван вне ReceiptCardProvider — провайдер стоит в Layout');
  }
  return ctx;
}

/** Номер ДО как ссылка на карточку прихода — по образцу OrderRef */
export function ReceiptRef({
  id, number, size = 'sm', bold = true,
}: {
  id: string;
  number: string;
  size?: string;
  bold?: boolean;
}) {
  const { open } = useReceiptCard();
  return (
    <Text
      component="button"
      type="button"
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); open(id); }}
      size={size}
      fw={bold ? 700 : 500}
      ff="monospace"
      c="brand.7"
      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
    >
      {number}
    </Text>
  );
}
