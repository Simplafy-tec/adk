import { cn } from '../cn.js';
import type { ToastPayload } from '../bridge.js';

const VARIANTES: Record<ToastPayload['variant'], string> = {
  success: 'border-success/40 bg-success/10 text-foreground',
  error: 'border-destructive/40 bg-destructive/10 text-foreground',
  warning: 'border-warning/40 bg-warning/10 text-foreground',
  info: 'border-info/40 bg-info/10 text-foreground',
};

export interface ToastProps extends ToastPayload {
  onDismiss?: () => void;
}

/**
 * `role="status"` + `aria-live="polite"`: o leitor de tela anuncia o toast sem
 * roubar o foco de quem está digitando.
 */
export function Toast({ variant, title, description, onDismiss }: ToastProps) {
  return (
    <div
      data-slot="toast"
      role="status"
      aria-live="polite"
      className={cn(
        'flex w-80 items-start gap-3 rounded-md border p-4 font-sans',
        VARIANTES[variant],
      )}
    >
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          aria-label="Fechar aviso"
          onClick={onDismiss}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

/** Pilha de toasts — no máximo 3, como o `toast-store.ts` do Hub. */
export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: readonly (ToastPayload & { id: string })[];
  onDismiss?: (id: string) => void;
}) {
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 flex flex-col gap-2">
      {toasts.slice(-3).map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <Toast {...t} onDismiss={onDismiss ? () => onDismiss(t.id) : undefined} />
        </div>
      ))}
    </div>
  );
}
