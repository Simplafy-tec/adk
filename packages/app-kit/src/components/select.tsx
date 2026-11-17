import type { SelectHTMLAttributes } from 'react';
import { cn } from '../cn.js';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: readonly SelectOption[];
}

/**
 * `<select>` nativo. ponytail: o combobox com portal do produto existe para
 * casos que o nativo não cobre (busca, multi, grupos ricos); num app embutido
 * em iframe o nativo é MAIS acessível — teclado, leitor de tela e o picker do
 * mobile vêm prontos, e nenhum portal escapa do iframe.
 */
export function Select({ options, className, children, ...props }: SelectProps) {
  return (
    <select
      data-slot="select"
      className={cn(
        'h-10 w-full rounded-sm border border-border bg-card px-3 font-sans text-sm text-foreground',
        'focus-visible:outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/20',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {options?.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
  );
}
