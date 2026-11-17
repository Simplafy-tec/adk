import type { HTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type BadgeVariant = 'default' | 'success' | 'warning' | 'destructive' | 'muted';

const VARIANTES: Record<BadgeVariant, string> = {
  default: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  destructive: 'bg-destructive/10 text-destructive',
  muted: 'bg-muted text-muted-foreground',
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
}

/** Status/rótulo. Existe para que ninguém estilize um `<span>` na mão. */
export function Badge({ variant = 'default', className, ...props }: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(
        'inline-flex items-center rounded-pill px-2.5 py-0.5 font-sans text-xs font-medium',
        VARIANTES[variant],
        className,
      )}
      {...props}
    />
  );
}
