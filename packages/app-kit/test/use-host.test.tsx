// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_ORIGINS_PADRAO, useHost } from '../src/use-host.js';

// Rodada de correção N19, item 3 (GATE 2/4 do brief original, sem teste).
// `useHost` só fala com uma origem que esteja na allowlist — fora dela,
// `hostOrigin` fica `null` e todo `enviar` (toast/dialog/navigate/ready) vira
// no-op (guard `if (!destino || !hostOrigin) return;`).

describe('useHost — no-op fora da allowlist', () => {
  it('hostOrigin fora da allowlist ⇒ hostOrigin fica null (ponte vira no-op)', () => {
    const { result } = renderHook(() =>
      useHost({
        hostOrigin: 'https://evil.example.com',
        allowlist: ['https://hub.example.com'],
      }),
    );
    expect(result.current.hostOrigin).toBeNull();
  });

  it('hostOrigin dentro da allowlist ⇒ hostOrigin é o valor confiável', () => {
    const { result } = renderHook(() =>
      useHost({
        hostOrigin: 'https://hub.example.com',
        allowlist: ['https://hub.example.com'],
      }),
    );
    expect(result.current.hostOrigin).toBe('https://hub.example.com');
  });
});

// O `hostOrigin: null` acima é só o SINTOMA; o que protege de verdade é o
// guard em `enviar` — sem exercitá-lo, remover a checagem passa despercebido
// (mutation check da review: o mutante sobreviveu com 170 verdes).
//
// Em jsdom `window.parent === window`, e o segundo guard (`destino === window`)
// mascararia o primeiro. Por isso o parent é substituído por um objeto próprio:
// assim quem decide é a allowlist, não o acidente do ambiente.
describe('useHost — a ponte não FALA com origem fora da allowlist', () => {
  const parentOriginal = Object.getOwnPropertyDescriptor(window, 'parent');

  function fingirParent() {
    const postMessage = vi.fn();
    Object.defineProperty(window, 'parent', {
      value: { postMessage },
      configurable: true,
      writable: true,
    });
    return postMessage;
  }

  afterEach(() => {
    if (parentOriginal) Object.defineProperty(window, 'parent', parentOriginal);
  });

  it('fora da allowlist: toast/dialog/navigate NÃO disparam postMessage', () => {
    const postMessage = fingirParent();

    const { result } = renderHook(() =>
      useHost({
        hostOrigin: 'https://evil.example.com',
        allowlist: ['https://hub.example.com'],
      }),
    );

    result.current.toast({ variant: 'success', title: 'Não pode sair daqui' });
    result.current.dialog({ title: 'Nem isto', description: 'nada' });
    result.current.navigate({ path: '/nem-isto' });

    // Nem o `ready` automático do mount pode ter vazado.
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('dentro da allowlist: o envio sai com a origem confiável como targetOrigin', () => {
    const postMessage = fingirParent();

    const { result } = renderHook(() =>
      useHost({
        hostOrigin: 'https://hub.example.com',
        allowlist: ['https://hub.example.com'],
      }),
    );

    result.current.toast({ variant: 'success', title: 'Pode' });

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'toast' }),
      'https://hub.example.com',
    );
  });
});

// issue#2593 — descoberta da origem quando o `document.referrer` chega VAZIO.
//
// O Hub renderiza o iframe do app com `referrerPolicy="no-referrer"`
// (`external-app-surface.tsx`, deliberado: o caminho do Hub não vaza no
// Referer). Isso zera o `document.referrer`, a descoberta padrão devolve
// `null`, e a ponte inteira vira no-op — sem `ready`, o host nunca manda o
// tema, e sem `hostOrigin` o app nunca manda `toast`/`dialog`/`navigate`.
//
// `ancestorOrigins` sobrevive ao `no-referrer` porque não é um header: é o
// navegador contando quem está por fora. A DESCOBERTA muda; a decisão de
// confiança não — o valor continua sendo conferido contra a allowlist.
//
// Medido em staging (04/09/2026): com o referrer vazio a tela do
// `prototipo-adk` mostrava "origem: nenhuma" e ficava em `tema: system` com o
// Hub em dark; com `ancestorOrigins`, `origem: https://app-staging…` e
// `tema: dark`.
describe('useHost — origem por ancestorOrigins (issue#2593)', () => {
  function comAncestorOrigins(origens: string[] | undefined, referrer = ''): void {
    Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });
    Object.defineProperty(window.location, 'ancestorOrigins', {
      value: origens === undefined ? undefined : Object.assign([...origens], { item: (i: number) => origens[i] }),
      configurable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(document, 'referrer', { value: '', configurable: true });
    Object.defineProperty(window.location, 'ancestorOrigins', {
      value: undefined,
      configurable: true,
    });
  });

  it('referrer vazio + ancestorOrigins na allowlist ⇒ acha a origem', () => {
    comAncestorOrigins(['https://hub.example.com']);
    const { result } = renderHook(() =>
      useHost({ allowlist: ['https://hub.example.com'] }),
    );
    expect(result.current.hostOrigin).toBe('https://hub.example.com');
  });

  it('ancestorOrigins FORA da allowlist ⇒ segue null (a descoberta não afrouxa a confiança)', () => {
    comAncestorOrigins(['https://evil.example.com']);
    const { result } = renderHook(() =>
      useHost({ allowlist: ['https://hub.example.com'] }),
    );
    expect(result.current.hostOrigin).toBeNull();
  });

  it('o `hostOrigin` declarado continua tendo precedência sobre a descoberta', () => {
    comAncestorOrigins(['https://hub.example.com']);
    const { result } = renderHook(() =>
      useHost({
        hostOrigin: 'https://outro.example.com',
        allowlist: ['https://outro.example.com', 'https://hub.example.com'],
      }),
    );
    expect(result.current.hostOrigin).toBe('https://outro.example.com');
  });

  it('referrer PRESENTE continua valendo — ancestorOrigins não o substitui', () => {
    comAncestorOrigins(['https://evil.example.com'], 'https://hub.example.com/hub/apps/x');
    const { result } = renderHook(() =>
      useHost({ allowlist: ['https://hub.example.com'] }),
    );
    expect(result.current.hostOrigin).toBe('https://hub.example.com');
  });

  it('sem ancestorOrigins (Firefox não implementa) e sem referrer ⇒ null, sem quebrar', () => {
    comAncestorOrigins(undefined);
    const { result } = renderHook(() =>
      useHost({ allowlist: ['https://hub.example.com'] }),
    );
    expect(result.current.hostOrigin).toBeNull();
  });

  it('ancestorOrigins VAZIO (não está embutido) ⇒ null', () => {
    comAncestorOrigins([]);
    const { result } = renderHook(() =>
      useHost({ allowlist: ['https://hub.example.com'] }),
    );
    expect(result.current.hostOrigin).toBeNull();
  });

  it('usa o ancestral IMEDIATO, não um avô mais distante', () => {
    // [0] é quem embutiu; os seguintes são os avós. Confiar num avô deixaria
    // um iframe intermediário hostil se passar pelo host.
    comAncestorOrigins(['https://evil.example.com', 'https://hub.example.com']);
    const { result } = renderHook(() =>
      useHost({ allowlist: ['https://hub.example.com'] }),
    );
    expect(result.current.hostOrigin).toBeNull();
  });
});

// issue#2593 (achado irmão) — staging não estava na allowlist padrão, então
// TODO app desenvolvido contra staging precisava passar `allowlist` à mão.
describe('HOST_ORIGINS_PADRAO', () => {
  it('inclui produção e staging', () => {
    expect(HOST_ORIGINS_PADRAO).toContain('https://app.simplafy.com.br');
    expect(HOST_ORIGINS_PADRAO).toContain('https://app-staging.simplafy.com.br');
  });

  it('não tem entrada de localhost — host local só entra quando o APP é local', () => {
    for (const origem of HOST_ORIGINS_PADRAO) {
      expect(origem).not.toContain('localhost');
      expect(origem).not.toContain('127.0.0.1');
    }
  });
});
