import React from 'react';
import { IconLayoutGrid, IconList } from '@tabler/icons-react';
import { Icon } from './Icon';

/**
 * Переключатель «сводка ↔ список» (02.09.2026).
 *
 * Экран открывается сводкой: крупные числа и конкретные виновники.
 * Список никуда не делся — он здесь, одной кнопкой, для случая «мне нужна
 * вот эта строка». Так у человека остаётся выбор, но по умолчанию он
 * видит ответ, а не базу данных.
 */
export function ViewSwitch({
  value, onChange, digestLabel = 'Сводка', listLabel = 'Все записи',
}: {
  value: 'digest' | 'list';
  onChange: (v: 'digest' | 'list') => void;
  digestLabel?: string;
  listLabel?: string;
}) {
  return (
    <div className="view-switch" role="tablist">
      <button
        type="button" role="tab" aria-selected={value === 'digest'}
        data-active={value === 'digest' ? 'true' : undefined}
        onClick={() => onChange('digest')}
      >
        <Icon icon={IconLayoutGrid} size={16} /> {digestLabel}
      </button>
      <button
        type="button" role="tab" aria-selected={value === 'list'}
        data-active={value === 'list' ? 'true' : undefined}
        onClick={() => onChange('list')}
      >
        <Icon icon={IconList} size={16} /> {listLabel}
      </button>
    </div>
  );
}
