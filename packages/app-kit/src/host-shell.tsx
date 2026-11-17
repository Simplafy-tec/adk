/**
 * `HostShell` — o lado HOST da ponte, e o Hub shell local do `adk dev`.
 *
 * Embute o app num `<iframe>`, injeta o tema pela ponte e RENDERIZA os efeitos
 * que o app pediu (toast, dialog). Não é uma maquete: é o mesmo contrato que o
 * AppSurface do Hub (N13) vai implementar, então o que funciona aqui funciona
 * lá — e o que o app tentar fora do contrato é descartado nos dois.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brand } from './brand.js';
import { Button } from './components/button.js';
import { Dialog } from './components/dialog.js';
import { ToastStack } from './components/toast.js';
import {
  envelope,
  parseIncoming,
  postMessageTo,
  type DialogPayload,
  type ToastPayload,
} from './bridge.js';
import { applyTheme, type Theme } from './theme.js';

export interface HostShellProps {
  /** URL do app (o Vite do `adk dev`). Define a origem confiável. */
  appUrl: string;
  title?: string;
  /** Tema inicial. O shell continua dono da troca. */
  defaultTheme?: Theme;
  /**
   * Origens aceitas no `postMessage`. Default: só a origem de `appUrl` —
   * deixar cair para `'*'` seria aceitar toast de qualquer aba embutida.
   */
  allowlist?: readonly string[];
  onNavigate?: (path: string) => void;
  /**
   * `sandbox` do iframe. Fica INDEFINIDO por padrão de propósito: sem
   * `allow-same-origin` o `event.origin` do app vira `"null"` e a allowlist —
   * que é a defesa de verdade — passaria a rejeitar tudo. O AppSurface do Hub
   * (N13) serve o app de uma origem PRÓPRIA e aí sim liga o sandbox junto.
   */
  sandbox?: string;
}

type ToastNaPilha = ToastPayload & { id: string };

export function HostShell({
  appUrl,
  title = 'Hub shell (local)',
  defaultTheme = 'light',
  allowlist,
  onNavigate,
  sandbox,
}: HostShellProps) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const proximoIdDeToast = useRef(0);
  const [theme, setTheme] = useState<Theme>(defaultTheme);
  const [toasts, setToasts] = useState<ToastNaPilha[]>([]);
  const [dialog, setDialog] = useState<DialogPayload | null>(null);

  const origemDoApp = useMemo(() => {
    try {
      return new URL(appUrl).origin;
    } catch {
      return null;
    }
  }, [appUrl]);

  const origensAceitas = useMemo(
    () => allowlist ?? (origemDoApp ? [origemDoApp] : []),
    [allowlist, origemDoApp],
  );

  const enviarTema = useCallback(
    (valor: Theme) => {
      const janela = iframe.current?.contentWindow;
      if (!janela || !origemDoApp) return;
      postMessageTo(janela, envelope('theme', { theme: valor }), origemDoApp);
    },
    [origemDoApp],
  );

  useEffect(() => {
    applyTheme(theme);
    enviarTema(theme);
  }, [theme, enviarTema]);

  useEffect(() => {
    const ouvir = (evento: MessageEvent): void => {
      const janelaDoApp = iframe.current?.contentWindow;
      if (!janelaDoApp || evento.source !== janelaDoApp) return;
      const mensagem = parseIncoming(evento, origensAceitas);
      if (!mensagem) return;
      switch (mensagem.type) {
        case 'toast':
          setToasts((atuais) =>
            [...atuais, { ...mensagem.payload, id: `${proximoIdDeToast.current++}` }].slice(-3),
          );
          break;
        case 'dialog':
          setDialog(mensagem.payload);
          break;
        case 'navigate':
          onNavigate?.(mensagem.payload.path);
          break;
        case 'ready':
          // O app montou: só agora a janela dele existe para receber o tema.
          enviarTema(theme);
          break;
        case 'theme':
          // O tema é do HOST. Um app não decide o tema do Hub.
          break;
      }
    };
    window.addEventListener('message', ouvir);
    return () => window.removeEventListener('message', ouvir);
  }, [origensAceitas, onNavigate, enviarTema, theme]);

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <header className="flex items-center gap-4 border-b border-border px-4 py-3">
        <Brand />
        <span className="font-sans text-sm text-muted-foreground">{title}</span>
        <Button
          className="ml-auto"
          variant="outline"
          size="sm"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          Tema: {theme}
        </Button>
      </header>

      <iframe
        ref={iframe}
        title={title}
        src={appUrl}
        className="flex-1 border-0"
        sandbox={sandbox}
      />

      <ToastStack
        toasts={toasts}
        onDismiss={(id) => setToasts((atuais) => atuais.filter((t) => t.id !== id))}
      />

      {dialog ? (
        <Dialog
          open
          {...dialog}
          onConfirm={() => setDialog(null)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}
