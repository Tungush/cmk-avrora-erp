import React from 'react';
import { TextInput, Tooltip, Group } from '@mantine/core';
import { IconLock } from '@tabler/icons-react';
import { Icon } from './Icon';

interface CalculatedFieldProps {
  label?: string;
  value: string | number;
  className?: string;
}

export function CalculatedField({ label, value, className }: CalculatedFieldProps) {
  return (
    <Tooltip label="Рассчитывается автоматически" withArrow>
      <TextInput
        label={label}
        className={className}
        value={String(value ?? '')}
        readOnly
        disabled
        size="md"
        rightSection={
          <Group gap="xs" pr="sm">
            <Icon icon={IconLock} size={16} />
          </Group>
        }
        rightSectionPointerEvents="none"
      />
    </Tooltip>
  );
}
