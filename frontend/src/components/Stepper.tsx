import React from 'react';
import { Stepper as MantineStepper } from '@mantine/core';

interface StepperProps {
  steps: string[];
  currentStep: number;
}

export function Stepper({ steps, currentStep }: StepperProps) {
  return (
    <MantineStepper
      active={currentStep}
      wrap={false}
      allowNextStepsSelect={false}
      size="sm"
      iconSize={32}
    >
      {steps.map((step) => (
        <MantineStepper.Step label={step} key={step} allowStepSelect={false} />
      ))}
    </MantineStepper>
  );
}
