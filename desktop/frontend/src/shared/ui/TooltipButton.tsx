import type { ComponentProps } from 'react';

import { NeumorphicButton } from './NeumorphicButton';
import { TooltipTarget } from './TooltipTarget';

type TooltipButtonProps = Omit<ComponentProps<typeof NeumorphicButton>, 'title'> & {
  title?: string;
  tooltipPlacement?: ComponentProps<typeof TooltipTarget>['placement'];
};

export function TooltipButton({ title, tooltipPlacement, ...props }: TooltipButtonProps) {
  return <TooltipTarget content={title} placement={tooltipPlacement}><NeumorphicButton {...props} /></TooltipTarget>;
}
