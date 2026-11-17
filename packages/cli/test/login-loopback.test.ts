import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { beginLogin, explicarErroDeAutorizacao } from '../src/auth.js';

// `adk login`: DCR único, PKCE S256, state aleatório, listener SÓ em 127.0.0.1,
// porta efêmera, one-shot. (Predictable security risks — brief §"Callback do login")

const HUB = 'http://hub-mock.test';

const server = setupServer(
  http.post(`${HUB}/api/oauth/register`, async ({ request }) => {
    const body = (await request.json()) as { redirect_uris: string[] };
    // Prova que o redirect_uri pedido é loopback, nunca 0.0.0.0/público.
    expect(body.redirect_uris.every((u) => /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(u))).toBe(
      true,
    );
    return HttpResponse.json({
      client_id: 'client-abc',
      redirect_uris: body.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_method: 'none',
    });
  }),
);

// 'bypass' (não 'error'): o fetch de teste para o próprio listener loopback
// (127.0.0.1:<porta>/callback) não tem handler MSW — e não deveria ter, é o
// SUT rodando de verdade, não o Hub mockado. Só a rota /api/oauth/register
// continua estritamente mockada acima.
beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('beginLogin — listener do callback', () => {
  it('vincula o listener em 127.0.0.1, nunca 0.0.0.0', async () => {
    const login = await beginLogin({ hubUrl: HUB });
    expect(login.address).toBe('127.0.0.1');
    await login.close();
  });

  it('a authorizeUrl pede scope=adk e org_scope=all com PKCE S256', async () => {
    const login = await beginLogin({ hubUrl: HUB });
    const url = new URL(login.authorizeUrl);
    expect(url.searchParams.get('scope')).toBe('adk');
    expect(url.searchParams.get('org_scope')).toBe('all');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    await login.close();
  });

  it('request ao callback com state errado é rejeitado e o listener continua one-shot', async () => {
    const login = await beginLogin({ hubUrl: HUB });
    const url = new URL(login.authorizeUrl);
    const callbackUrl = new URL(`http://127.0.0.1:${login.port}/callback`);
    callbackUrl.searchParams.set('code', 'codigo-qualquer');
    callbackUrl.searchParams.set('state', 'estado-errado-nao-e-' + url.searchParams.get('state'));

    const resposta = await fetch(callbackUrl);
    expect(resposta.status).toBeGreaterThanOrEqual(400);
    await expect(login.waitForCallback()).rejects.toThrow();
    await login.close();
  });
});

// issue#2775 — a CLI repassava o código cru do protocolo. Quem nunca ouviu
// falar de "scope" recebia `invalid_scope` e não tinha como ligar isso ao
// interruptor que ficou desligado na tela de autorização.
describe('mensagem de erro da autorização', () => {
  it('invalid_scope diz o que fazer, não só o código', () => {
    const msg = explicarErroDeAutorizacao('invalid_scope');
    expect(msg).toContain('invalid_scope');
    expect(msg).toMatch(/permissão ADK/i);
    expect(msg).toContain('adk login');
  });

  it('access_denied vira a frase do que aconteceu', () => {
    expect(explicarErroDeAutorizacao('access_denied')).toMatch(/negada/i);
  });

  it('código desconhecido é repassado sem invenção', () => {
    expect(explicarErroDeAutorizacao('server_error')).toBe('O Hub recusou o login: server_error');
  });
});
