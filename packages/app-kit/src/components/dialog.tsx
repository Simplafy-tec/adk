import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button } from './button.js';
import { cn } from '../cn.js';

export interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  cancelLabel?: string;
  confirmLabel?: string;
  confirmVariant?: 'default' | 'destructive';
  loading?: boolean;
  onConfirm?: () => void;
  onCancel?: () => void;
}

/**
 * `<dialog>` nativo com `showModal()`.
 *
 * ponytail: sem Radix. O elemento nativo já entrega foco preso no diálogo,
 * fechar no Esc, `aria-modal` e a `::backdrop` — que é exatamente o que a
 * camada de portal do produto reimplementa. Se o app um dia precisar de
 * diálogo NÃO modal ancorado a um gatilho, aí o nativo não cobre.
 *
 * O shape dos campos é o do `ModalConfirmProps` do `@simplafy-tec/ui` de
 * propósito: é este o payload `dialog` da ponte, e o host tem de conseguir
 * renderizar o que o app pediu sem tradução.
 */
export function Dialog({
  open,
  title,
  description,
  children,
  cancelLabel = 'Cancelar',
  confirmLabel = 'Confirmar',
  confirmVariant = 'default',
  loading = false,
  onConfirm,
  onCancel,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      data-slot="dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onCancel?.();
      }}
      className={cn(
        'rounded-lg border border-border bg-popover p-6 text-popover-foreground',
        'w-[min(28rem,90vw)] backdrop:bg-foreground/40',
      )}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          {description ? (
            <p className="font-sans text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {children}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} disabled={loading}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
