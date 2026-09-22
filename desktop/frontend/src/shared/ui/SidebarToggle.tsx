import { createContext, useContext, type ComponentProps } from 'react';
import { NeumorphicButton } from './NeumorphicButton';

// Workspace headers expose the right-hand toggle only when a review is available.
export const SidebarToggleVisibility = createContext(true);

export function SidebarToggle(props: ComponentProps<typeof NeumorphicButton>) {
  const visible = useContext(SidebarToggleVisibility);
  return visible ? <NeumorphicButton {...props} /> : null;
}
