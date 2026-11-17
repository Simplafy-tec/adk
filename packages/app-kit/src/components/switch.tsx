import type { InputHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string;
}

/**
 * `<input type="checkbox" role="switch">` — semântica nativa de alternância,
 * reconhecida por leitor de tela sem uma linha de ARIA manual.
 */
export function Switch({ label, className, ...props }: SwitchProps) {
  const controle = (
    <input
      type="checkbox"
      role="switch"
      data-slot="switch"
      className={cn(
        'h-5 w-9 cursor-pointer appearance-none rounded-pill border border-border bg-muted transition',
        'checked:bg-primary',
        'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
  if (!label) return controle;
  return (
    <label className="inline-flex items-center gap-2 font-sans text-sm text-foreground">
      {controle}
      {label}
    </label>
  );
}
