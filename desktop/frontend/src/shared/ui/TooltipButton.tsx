import type { ComponentProps } from 'react';

import { NeumorphicButton } from './NeumorphicButton';
import { Tooltip } from './Tooltip';

type TooltipButtonProps = Omit<ComponentProps<typeof NeumorphicButton>, 'title'> & { title: string };

export function TooltipButton({ title, onPointerEnter, onPointerLeave, onFocus, onBlur, ...props }: TooltipButtonProps) {
  return <Tooltip<HTMLButtonElement> content={title}>
    {trigger => <NeumorphicButton {...props} {...trigger}
      onPointerEnter={event => { trigger.onPointerEnter?.(event); onPointerEnter?.(event); }}
      onPointerLeave={event => { trigger.onPointerLeave?.(event); onPointerLeave?.(event); }}
      onFocus={event => { trigger.onFocus?.(event); onFocus?.(event); }}
      onBlur={event => { trigger.onBlur?.(event); onBlur?.(event); }}
    />}
  </Tooltip>;
}
