import { describe, expect, it } from 'vitest';
import { NavigatePayloadSchema, parseIncoming } from '../src/bridge.js';

// Ponte postMessage (ADR-120 §5): envelope versionado {v:1, type, payload},
// com validação por 3 camadas — origem (allowlist) → type conhecido → schema
// do payload — no padrão de zernio-wizard.tsx (C-1/R-1/R-2). Nenhuma das três
// falha em silêncio: mensagem fora do contrato é ignorada (retorna null), não
// lançada, porque o remetente é um iframe não confiável (R-1: "a fonte é o
// servidor, NUNCA o postMessage").

const ALLOWLIST = ['https://hub.example.com', 'http://localhost:5173'];

describe('parseIncoming — bridge do HostShell', () => {
  it('entrega o envelope quando origem, v e type são válidos (toast)', () => {
    const evento = {
      origin: 'http://localhost:5173',
      data: { v: 1, type: 'toast', payload: { variant: 'success', title: 'Salvo' } },
    };
    const resultado = parseIncoming(evento, ALLOWLIST);
    expect(resultado).toEqual({
      v: 1,
      type: 'toast',
      payload: { variant: 'success', title: 'Salvo' },
    });
  });

  it('ignora mensagem de origem fora da allowlist', () => {
    const evento = {
      origin: 'https://evil.example.com',
      data: { v: 1, type: 'toast', payload: { variant: 'success', title: 'Salvo' } },
    };
    expect(parseIncoming(evento, ALLOWLIST)).toBeNull();
  });

  it('ignora mensagem com v desconhecida', () => {
    const evento = {
      origin: 'http://localhost:5173',
      data: { v: 2, type: 'toast', payload: { variant: 'success', title: 'Salvo' } },
    };
    expect(parseIncoming(evento, ALLOWLIST)).toBeNull();
  });

  it('ignora mensagem com type desconhecido', () => {
    const evento = {
      origin: 'http://localhost:5173',
      data: { v: 1, type: 'do-something-privileged', payload: {} },
    };
    expect(parseIncoming(evento, ALLOWLIST)).toBeNull();
  });

  it('ignora toast com variant fora de success|error|warning|info (contrato do toast-store do Hub)', () => {
    const evento = {
      origin: 'http://localhost:5173',
      data: { v: 1, type: 'toast', payload: { variant: 'oops', title: 'Salvo' } },
    };
    expect(parseIncoming(evento, ALLOWLIST)).toBeNull();
  });

  it('ignora payload malformado (dado não é objeto)', () => {
    const evento = { origin: 'http://localhost:5173', data: 'não é json' };
    expect(parseIncoming(evento, ALLOWLIST)).toBeNull();
  });
});

// Item 3 do brief de correção N19 (GATE 2/4 sem teste): NavigatePayloadSchema
// é o que fecha a porta para open-redirect — `path` tem de ser um caminho
// INTERNO do Hub, nunca um esquema (`javascript:`) nem um protocol-relative
// URL (`//evil.com`, que o navegador trata como outra origem).
describe('NavigatePayloadSchema — anti open-redirect', () => {
  it('rejeita "javascript:" (não começa com "/")', () => {
    expect(NavigatePayloadSchema.safeParse({ path: 'javascript:alert(1)' }).success).toBe(false);
  });

  it('rejeita "//evil.com" (protocol-relative — o navegador trata como outra origem)', () => {
    expect(NavigatePayloadSchema.safeParse({ path: '//evil.com' }).success).toBe(false);
  });

  it('aceita um caminho interno normal', () => {
    expect(NavigatePayloadSchema.safeParse({ path: '/orgs/demo/agentes' }).success).toBe(true);
  });

  // Regressão do open redirect (espelha o fix do hub-v2 `5b4b2f99`): o parser
  // WHATWG REMOVE U+0000-U+001F antes de resolver, então estes passavam na
  // regex `/^\/[^/\\]/` e resolviam para origem externa.
  it.each([
    ['tab', '/\t/evil.com'],
    ['lf', '/\n/evil.com'],
    ['cr', '/\r/evil.com'],
    ['tab + barra invertida', '/\t\\evil.com'],
  ])('navigate recusa caractere de controle (%s)', (_nome, path) => {
    expect(
      NavigatePayloadSchema.safeParse({ path }).success,
    ).toBe(false);
  });

  it('navigate aceita caminho interno legítimo', () => {
    expect(NavigatePayloadSchema.safeParse({ path: '/leads/42' }).success).toBe(true);
  });
});
