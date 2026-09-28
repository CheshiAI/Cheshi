import type { ComponentProps } from 'react';

import { NeumorphicButton } from './NeumorphicButton';
import { TooltipTarget } from './TooltipTarget';

type TooltipButtonProps = Omit<ComponentProps<typeof NeumorphicButton>, 'title'> & { title?: string };

export function TooltipButton({ title, ...props }: TooltipButtonProps) {
  return <TooltipTarget content={title}><NeumorphicButton {...props} /></TooltipTarget>;
}
