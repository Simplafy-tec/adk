/**
 * Contrato: a CLI não pode ASSUMIR que o servidor de autorização OAuth e as
 * rotas `/api/v1/adk/*` moram na mesma origem.
 *
 * POR QUE ISTO EXISTE
 * -------------------
 * Medido contra o ambiente de staging real, em 2026-09-01:
 *
 *   https://api-hub-v2-staging.simplafy.com.br   → GET /api/v1/adk/policy 200
 *                                                  POST /api/oauth/register 404
 *   https://app-staging.simplafy.com.br/hub      → POST /api/oauth/register 201
 *                                                  GET /api/v1/adk/policy 404
 *
 * O AS vive no `apps/web` (Next.js, `basePath: '/hub'`); as rotas do ADK vivem
 * no `apps/api` (NestJS), em outro host. Como `hubUrl()` era a única fonte para
 * os dois, NENHUM valor de `ADK_HUB_URL` fazia a CLI funcionar inteira:
 * apontando para a API, `adk login` morria com "O Hub recusou o registro do
 * cliente (404)"; apontando para o web, `adk doctor` caía na política embutida.
 *
 * `authUrl()` separa as duas coisas, mantendo o default no próprio Hub — quem
 * roda tudo na mesma origem (dev local) não precisa configurar nada.
 */
import { describe, expect, it } from 'vitest';
import { authUrl, hubUrl } from '../packages/cli/src/ctx.js';

const ctx = (env: NodeJS.ProcessEnv) =>
  ({ cwd: '/', env, out: () => undefined, err: () => undefined }) as never;

describe('authUrl — origem do servidor de autorização', () => {
  it('sem ADK_AUTH_URL, cai no próprio Hub (mesma origem, caso simples)', () => {
    const c = ctx({ ADK_HUB_URL: 'https://hub.exemplo.test' });
    expect(authUrl(c)).toBe('https://hub.exemplo.test');
    expect(hubUrl(c)).toBe('https://hub.exemplo.test');
  });

  it('com ADK_AUTH_URL, o AS é outro host — e o Hub NÃO muda', () => {
    // É o desenho real de staging/produção: web e api em hosts distintos.
    const c = ctx({
      ADK_HUB_URL: 'https://api-hub-v2-staging.simplafy.com.br',
      ADK_AUTH_URL: 'https://app-staging.simplafy.com.br/hub',
    });
    expect(authUrl(c)).toBe('https://app-staging.simplafy.com.br/hub');
    expect(hubUrl(c)).toBe('https://api-hub-v2-staging.simplafy.com.br');
  });

  it('tira a barra final, como hubUrl — senão vira //api/oauth/register', () => {
    const c = ctx({ ADK_HUB_URL: 'https://h.test', ADK_AUTH_URL: 'https://as.test/hub/' });
    expect(authUrl(c)).toBe('https://as.test/hub');
  });

  it('ADK_AUTH_URL vazia ou só espaços não conta como configurada', () => {
    // Guarda contra o fail-open silencioso: `ADK_AUTH_URL=` no shell não pode
    // virar string vazia e produzir `/api/oauth/register` sem host.
    expect(authUrl(ctx({ ADK_HUB_URL: 'https://h.test', ADK_AUTH_URL: '   ' }))).toBe(
      'https://h.test',
    );
    expect(authUrl(ctx({ ADK_HUB_URL: 'https://h.test', ADK_AUTH_URL: '' }))).toBe(
      'https://h.test',
    );
  });

  it('sem Hub nem AS, cai no AS do perfil padrão (produção)', () => {
    expect(authUrl(ctx({}))).toBe('https://app.simplafy.com.br/hub');
  });

  it('ADK_AUTH_URL sozinha vale, mesmo sem ADK_HUB_URL', () => {
    expect(authUrl(ctx({ ADK_AUTH_URL: 'https://as.test' }))).toBe('https://as.test');
  });
});

/**
 * Sem `ADK_AUTH_URL`, cair no `ADK_HUB_URL` só serve a quem roda tudo na mesma
 * origem. Para os hosts conhecidos da API do Hub, o AS é o `apps/web` do mesmo
 * ambiente, e a CLI deriva sozinha: quem configura só `ADK_HUB_URL` (o que a
 * mensagem de `exigirHub` pede) não pode tomar 404 no registro do cliente.
 */
describe('authUrl — derivação do AS a partir do Hub conhecido', () => {
  it.each([
    ['https://api-hub-v2-staging.simplafy.com.br', 'https://app-staging.simplafy.com.br/hub'],
    ['https://api-hub-v2.simplafy.com.br', 'https://app.simplafy.com.br/hub'],
  ])('só ADK_HUB_URL=%s → AS em %s', (hub, esperado) => {
    expect(authUrl(ctx({ ADK_HUB_URL: hub }))).toBe(esperado);
  });

  it.each([
    ['https://api-hub-v2-staging.simplafy.com.br/', 'https://app-staging.simplafy.com.br/hub'],
    ['https://api-hub-v2.simplafy.com.br//', 'https://app.simplafy.com.br/hub'],
  ])('aceita barra final no Hub (%s) e deriva %s', (hub, esperado) => {
    expect(authUrl(ctx({ ADK_HUB_URL: hub }))).toBe(esperado);
  });

  it.each(['https://api.simplafy.com.br', 'https://api-staging.simplafy.com.br'])(
    '%s é a API do Saúde, não do Hub: não deriva e cai no próprio Hub',
    (hub) => {
      expect(authUrl(ctx({ ADK_HUB_URL: hub }))).toBe(hub);
    },
  );

  it('derivar o AS não muda o Hub: as rotas do ADK continuam na API', () => {
    const c = ctx({ ADK_HUB_URL: 'https://api-hub-v2-staging.simplafy.com.br' });
    expect(hubUrl(c)).toBe('https://api-hub-v2-staging.simplafy.com.br');
  });

  it('ADK_AUTH_URL definida vence a derivação, mesmo com Hub conhecido', () => {
    // Valor diferente do derivado: se a CLI ignorasse o override e derivasse,
    // o teste veria app-staging, não o host configurado.
    const c = ctx({
      ADK_HUB_URL: 'https://api-hub-v2-staging.simplafy.com.br',
      ADK_AUTH_URL: 'https://as-proprio.exemplo.test/hub/',
    });
    expect(authUrl(c)).toBe('https://as-proprio.exemplo.test/hub');
  });
});
