import React from 'react';
import { Modal as MantineModal, ScrollArea } from '@mantine/core';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: string | number;
}

export function Modal({ isOpen, onClose, title, children, size = 'lg' }: ModalProps) {
  return (
    <MantineModal
      opened={isOpen}
      onClose={onClose}
      title={title}
      size={size}
      radius="lg"
      withCloseButton
      centered
      scrollAreaComponent={ScrollArea.Autosize}
    >
      {children}
    </MantineModal>
  );
}
