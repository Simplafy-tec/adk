// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostShell } from '../src/host-shell.js';

// Rodada de correção N19 — GATE 2/4 do brief original (item 3, nunca
// testados) + item 2 (event.source) + item 8 (id de toast colidível).
//
// A allowlist do `HostShell` valida `event.origin`, mas dois apps embutidos
// da MESMA origem (cenário AppSurface do N13) conseguiam forjar toast/dialog
// um do outro só respeitando a origem — falta checar `event.source`.

const APP_URL = 'http://localhost:5173/';
const APP_ORIGIN = 'http://localhost:5173';

afterEach(cleanup);

function dispararMensagem(data: unknown, opts: { origin?: string; source?: Window | null } = {}) {
  const evento = new MessageEvent('message', {
    data,
    origin: opts.origin ?? APP_ORIGIN,
    source: opts.source ?? null,
  });
  act(() => {
    window.dispatchEvent(evento);
  });
}

describe('HostShell — bridge (item 2: event.source; GATE 2/4 do brief original)', () => {
  it('GATE 2: app emite toast pela ponte ⇒ host renderiza', () => {
    const { container } = render(<HostShell appUrl={APP_URL} />);
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const fonte = iframe.contentWindow as Window;

    dispararMensagem(
      { v: 1, type: 'toast', payload: { variant: 'success', title: 'Salvo com sucesso' } },
      { source: fonte },
    );

    expect(screen.getByText('Salvo com sucesso')).toBeInTheDocument();
  });

  it('GATE 4: troca de tema no host ⇒ app recebe theme pela ponte, sem rebuild', () => {
    const { container } = render(<HostShell appUrl={APP_URL} defaultTheme="light" />);
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const postMessage = vi.spyOn(iframe.contentWindow as Window, 'postMessage');

    fireEvent.click(screen.getByRole('button', { name: /tema: light/i }));

    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'theme', payload: { theme: 'dark' } }),
      APP_ORIGIN,
    );
  });

  it('item 2: mensagem de outra source (mesma origem) é IGNORADA — não é o iframe embutido', () => {
    const { container } = render(<HostShell appUrl={APP_URL} />);
    // O próprio `window` do teste tem a mesma origem do app (jsdom), mas não é
    // o `contentWindow` do iframe — é o cenário de dois apps na MESMA origem
    // (N13) se forjando um ao outro.
    dispararMensagem(
      { v: 1, type: 'toast', payload: { variant: 'success', title: 'Forjado' } },
      { source: window },
    );
    expect(container.querySelector('[data-slot="toast"]')).toBeNull();
  });

  it('item 2: mensagem cuja source É o contentWindow do iframe é aceita', () => {
    const { container } = render(<HostShell appUrl={APP_URL} />);
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    dispararMensagem(
      { v: 1, type: 'toast', payload: { variant: 'success', title: 'Legítimo' } },
      { source: iframe.contentWindow },
    );
    expect(screen.getByText('Legítimo')).toBeInTheDocument();
  });
});

describe('HostShell — id de toast (item 8: colisão com Date.now())', () => {
  it('toasts empilhados no MESMO tick recebem ids distintos, e o dismiss remove só o clicado', () => {
    const { container } = render(<HostShell appUrl={APP_URL} />);
    const iframe = container.querySelector('iframe') as HTMLIFrameElement;
    const fonte = iframe.contentWindow as Window;

    // Todos os 5 num único `act()` — mesmo tick síncrono, então
    // `Date.now()` (resolução de 1ms) é IDÊNTICO nos 5 pushes. A pilha
    // satura em 3 (ToastStack mantém só os últimos 3): a partir do 4º toast,
    // `atuais.length` fica preso em 3 e o id `${Date.now()}-${atuais.length}`
    // colide entre pushes consecutivos.
    act(() => {
      for (const title of ['T1', 'T2', 'T3', 'T4', 'T5']) {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { v: 1, type: 'toast', payload: { variant: 'info', title } },
            origin: APP_ORIGIN,
            source: fonte,
          }),
        );
      }
    });

    // Só os últimos 3 (T3, T4, T5) ficam visíveis.
    expect(screen.getByText('T3')).toBeInTheDocument();
    expect(screen.getByText('T4')).toBeInTheDocument();
    expect(screen.getByText('T5')).toBeInTheDocument();

    // Fecha o toast mais recente (T5) — só ele deve sumir.
    const botoesFechar = screen.getAllByRole('button', { name: 'Fechar aviso' });
    fireEvent.click(botoesFechar[botoesFechar.length - 1]);

    expect(screen.queryByText('T5')).toBeNull();
    expect(screen.getByText('T4')).toBeInTheDocument();
    expect(screen.getByText('T3')).toBeInTheDocument();
  });
});
