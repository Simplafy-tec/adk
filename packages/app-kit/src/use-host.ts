/**
 * `useHost()` — o lado APP da ponte.
 *
 * O app não fala com o Hub por import: ele roda num `<iframe>` e pede efeitos
 * (toast, dialog, navegação) por `postMessage`. Tudo o que volta do host passa
 * por `parseIncoming` — inclusive o tema, que é a única coisa que o host EMPURRA.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  envelope,
  parseIncoming,
  postMessageTo,
  type DialogPayload,
  type NavigatePayload,
  type ReadyPayload,
  type ToastPayload,
} from './bridge.js';
import { applyTheme, type Theme } from './theme.js';
import { HOST_ORIGINS_PADRAO, HOSTS_LOCAIS, PORTAS_SHELL_LOCAL } from './origens.js';

export { HOST_ORIGINS_PADRAO, HOSTS_LOCAIS, PORTAS_SHELL_LOCAL } from './origens.js';

function allowlistPadrao(): string[] {
  const origens = [...HOST_ORIGINS_PADRAO];
  if (typeof window === 'undefined') return origens;
  const { hostname, protocol } = window.location;
  // Só um app SERVIDO localmente confia num host local: em produção esta lista
  // não ganha nenhuma entrada de localhost.
  if (HOSTS_LOCAIS.includes(hostname)) {
    for (const h of HOSTS_LOCAIS) {
      for (const porta of PORTAS_SHELL_LOCAL) origens.push(`${protocol}//${h}:${porta}`);
    }
  }
  return origens;
}

export interface UseHostOptions {
  /** Origem exata do host. Default: a origem de quem embutiu (`document.referrer`). */
  hostOrigin?: string;
  /** Origens aceitas. Default: produção + shell local quando o app é local. */
  allowlist?: readonly string[];
  /** Aplicar a classe `.dark` ao receber `theme`. Default: sim. */
  applyThemeToDocument?: boolean;
}

export interface HostApi {
  /** Tema vigente no host. Muda sozinho quando a pessoa troca no Hub. */
  theme: Theme;
  /** Origem do host que está sendo usada, ou `null` se nenhuma é confiável. */
  hostOrigin: string | null;
  toast(payload: ToastPayload): void;
  dialog(payload: DialogPayload): void;
  navigate(payload: NavigatePayload): void;
  ready(payload?: ReadyPayload): void;
}

function origemDoReferrer(): string | null {
  if (typeof document === 'undefined' || !document.referrer) return null;
  try {
    return new URL(document.referrer).origin;
  } catch {
    return null;
  }
}

/**
 * Origem de quem embutiu, pelo navegador (issue#2593).
 *
 * O Hub renderiza o iframe do app com `referrerPolicy="no-referrer"` — é
 * deliberado, o caminho do Hub não vaza no `Referer`. Só que isso zera o
 * `document.referrer`, e com ele a descoberta acima devolve `null`: a ponte
 * inteira vira no-op, nos DOIS sentidos. Sem `hostOrigin` o app não manda
 * `ready`, e sem `ready` o host não manda o tema.
 *
 * `ancestorOrigins` sobrevive ao `no-referrer` porque não é um header — é o
 * navegador contando quem está por fora, e o app não pode forjá-lo.
 *
 * `[0]` é o ancestral IMEDIATO. Aceitar um avô deixaria um iframe intermediário
 * hostil se passar pelo host. Firefox não implementa a API: lá o valor é
 * `undefined` e o resultado continua sendo `null`, sem quebrar.
 */
function origemDeQuemEmbutiu(): string | null {
  if (typeof window === 'undefined') return null;
  const ancestrais = window.location.ancestorOrigins;
  if (!ancestrais || ancestrais.length === 0) return null;
  return ancestrais[0] ?? null;
}

export function useHost(options: UseHostOptions = {}): HostApi {
  const [theme, setTheme] = useState<Theme>('system');

  const allowlist = useMemo(() => options.allowlist ?? allowlistPadrao(), [options.allowlist]);

  // Origem do host, em ordem: a DECLARADA, o referrer, e por fim quem
  // embutiu (`ancestorOrigins` — ver `origemDeQuemEmbutiu`). Só a
  // descoberta tem três fontes; a decisão de confiança continua sendo uma
  // só: fora da allowlist fica `null` e a ponte vira no-op, nunca `'*'`.
  const hostOrigin = useMemo(() => {
    const candidata = options.hostOrigin ?? origemDoReferrer() ?? origemDeQuemEmbutiu();
    return candidata && allowlist.includes(candidata) ? candidata : null;
  }, [options.hostOrigin, allowlist]);

  const enviar = useCallback(
    (mensagem: ReturnType<typeof envelope>) => {
      if (typeof window === 'undefined' || !hostOrigin) return;
      const destino = window.parent;
      if (!destino || destino === window) return;
      postMessageTo(destino, mensagem, hostOrigin);
    },
    [hostOrigin],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const ouvir = (evento: MessageEvent): void => {
      const mensagem = parseIncoming(evento, allowlist);
      if (!mensagem || mensagem.type !== 'theme') return;
      setTheme(mensagem.payload.theme);
      if (options.applyThemeToDocument !== false) applyTheme(mensagem.payload.theme);
    };
    window.addEventListener('message', ouvir);
    return () => window.removeEventListener('message', ouvir);
  }, [allowlist, options.applyThemeToDocument]);

  // Avisa o host que a tela montou — é o gatilho para ele mandar o tema.
  useEffect(() => {
    enviar(envelope('ready', {}));
  }, [enviar]);

  return useMemo<HostApi>(
    () => ({
      theme,
      hostOrigin,
      toast: (payload) => enviar(envelope('toast', payload)),
      dialog: (payload) => enviar(envelope('dialog', payload)),
      navigate: (payload) => enviar(envelope('navigate', payload)),
      ready: (payload) => enviar(envelope('ready', payload ?? {})),
    }),
    [theme, hostOrigin, enviar],
  );
}
