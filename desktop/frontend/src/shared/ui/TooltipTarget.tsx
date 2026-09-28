import { cloneElement, type HTMLAttributes, type ReactElement } from 'react';

import { Tooltip } from './Tooltip';

type TargetProps = HTMLAttributes<HTMLElement> & { disabled?: boolean };

/** Keep the target's layout, ref and handlers while replacing its native title. */
export function TooltipTarget({ content, children }: {
  content?: string;
  children: ReactElement<TargetProps>;
}) {
  const props = children.props;
  // Keep the wrapper stable when a pending operation enables/disables its target.
  const wrapped = 'disabled' in props;
  const description = props['aria-description'] ?? content;
  return <Tooltip content={content}
    resolveAnchor={wrapped ? element => element.firstElementChild ?? element : undefined}>
    {trigger => wrapped ? (
      <span {...trigger} data-tooltip-wrapper="true" style={{ display: 'contents' }}>
        {cloneElement(children, {
          title: undefined,
          'aria-description': description,
          'aria-describedby': [props['aria-describedby'], trigger['aria-describedby']].filter(Boolean).join(' ') || undefined,
        })}
      </span>
    ) : cloneElement(children, {
      ...trigger,
      title: undefined,
      'aria-description': description,
      'aria-describedby': [props['aria-describedby'], trigger['aria-describedby']].filter(Boolean).join(' ') || undefined,
      onPointerEnter: event => { trigger.onPointerEnter?.(event); props.onPointerEnter?.(event); },
      onPointerOver: event => { trigger.onPointerOver?.(event); props.onPointerOver?.(event); },
      onPointerLeave: event => { trigger.onPointerLeave?.(event); props.onPointerLeave?.(event); },
      onFocus: event => { trigger.onFocus?.(event); props.onFocus?.(event); },
      onBlur: event => { trigger.onBlur?.(event); props.onBlur?.(event); },
    })}
  </Tooltip>;
}
