import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export type ButtonVariant = 'default' | 'outline' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTES: Record<ButtonVariant, string> = {
  default: 'bg-primary text-primary-foreground hover:opacity-90',
  outline: 'border border-border bg-card text-foreground hover:bg-accent',
  ghost: 'text-foreground hover:bg-accent',
  destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
};

const TAMANHOS: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/**
 * `<button>` nativo por baixo — o elemento certo já entrega foco, Enter/Espaço
 * e `disabled` de graça. `data-slot` segue a convenção do `@simplafy-tec/ui`.
 */
export function Button({ variant = 'default', size = 'md', className, ...props }: ButtonProps) {
  return (
    <button
      data-slot="button"
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-sm font-sans font-medium transition',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20 focus-visible:border-primary',
        'disabled:pointer-events-none disabled:opacity-50',
        VARIANTES[variant],
        TAMANHOS[size],
        className,
      )}
      {...props}
    />
  );
}
