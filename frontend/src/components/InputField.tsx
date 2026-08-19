import React from 'react';
import { TextInput } from '@mantine/core';
import { IconPencil } from '@tabler/icons-react';

interface InputFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}

export function InputField({ label, disabled, size = 'md', className, ...props }: InputFieldProps) {
  return (
    <TextInput
      label={label}
      disabled={disabled}
      size={size}
      className={className}
      rightSection={!disabled ? <IconPencil size={14} stroke={1.6} /> : null}
      rightSectionPointerEvents="none"
      {...props}
    />
  );
}
