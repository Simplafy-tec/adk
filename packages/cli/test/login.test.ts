import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveCredentials } from '../src/credentials.js';
import { runCli } from '../src/cli.js';

/**
 * `adk login` de ponta a ponta, em processo, com o Hub mockado.
 *
 * O AS (`/api/oauth/*`) é o `apps/web` (`app[-staging].simplafy.com.br/hub`);
 * as rotas do ADK, o `apps/api` (`api-hub-v2[-staging].simplafy.com.br`). Os
 * testes registram EM QUAL host o registro do cliente chegou — é o efeito que
 * separa "derivou o AS" de "mandou para a API e tomou 404".
 */

const API_STAGING = 'https://api-hub-v2-staging.simplafy.com.br';
const WEB_STAGING = 'https://app-staging.simplafy.com.br/hub';
const HUB_DESCONHECIDO = 'http://hub-mock.test';
const AS_CONFIGURADO = 'http://as-configurado.test/hub';

const registrosRecebidos: string[] = [];

const server = setupServer(
  // O registro no AS certo responde erro de propósito: o teste só precisa
  // saber ONDE ele chegou, e falhar aqui encerra o login sem abrir navegador
  // nem esperar callback.
  http.post(`${WEB_STAGING}/api/oauth/register`, ({ request }) => {
    registrosRecebidos.push(request.url);
    return HttpResponse.json({ error: 'invalid_client_metadata' }, { status: 400 });
  }),
  http.post(`${API_STAGING}/api/oauth/register`, ({ request }) => {
    registrosRecebidos.push(request.url);
    return HttpResponse.json({ message: 'Cannot POST /api/oauth/register' }, { status: 404 });
  }),
  http.post(`${AS_CONFIGURADO}/api/oauth/register`, ({ request }) => {
    registrosRecebidos.push(request.url);
    return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
  }),
  http.post(`${HUB_DESCONHECIDO}/api/oauth/register`, ({ request }) => {
    registrosRecebidos.push(request.url);
    return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
  }),
);

// Só o listener loopback do próprio `adk login` (127.0.0.1:<porta>/callback)
// passa sem handler: é o SUT rodando de verdade, não o Hub. Qualquer outra
// chamada não mockada é erro.
beforeAll(() =>
  server.listen({
    onUnhandledRequest(request, print) {
      if (new URL(request.url).hostname === '127.0.0.1') return;
      print.error();
    },
  }),
);
afterEach(() => {
  server.resetHandlers();
  registrosRecebidos.length = 0;
});
afterAll(() => server.close());

// `runCli` mescla `process.env`: sem anular aqui, um ADK_AUTH_URL do shell de
// quem roda a suíte mascararia a derivação.
const semAuthUrl = { ADK_AUTH_URL: undefined };

describe('adk login — servidor de autorização', () => {
  it('só com ADK_HUB_URL de staging, registra o cliente no app-staging/hub, não na API', async () => {
    await runCli(['login'], { env: { ...semAuthUrl, ADK_HUB_URL: API_STAGING } });

    expect(registrosRecebidos).toEqual([`${WEB_STAGING}/api/oauth/register`]);
  });

  it('404 no registro diz em pt-BR para definir ADK_AUTH_URL, não só o status', async () => {
    const result = await runCli(['login'], {
      env: { ...semAuthUrl, ADK_HUB_URL: HUB_DESCONHECIDO },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('ADK_AUTH_URL');
    expect(result.stderr).toMatch(/defina/i);
    expect(result.stderr).toMatch(/https:\/\/app(-staging)?\.simplafy\.com\.br\/hub/);
  });

  it('404 com ADK_AUTH_URL já definida manda conferir a variável e mostra o valor atual', async () => {
    const result = await runCli(['login'], {
      env: { ADK_HUB_URL: HUB_DESCONHECIDO, ADK_AUTH_URL: AS_CONFIGURADO },
    });

    expect(registrosRecebidos).toEqual([`${AS_CONFIGURADO}/api/oauth/register`]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/confira ADK_AUTH_URL/i);
    expect(result.stderr).toContain(AS_CONFIGURADO);
  });
});

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.assinatura`;
}

describe('adk whoami — token que o Hub recusa', () => {
  const env = { ...semAuthUrl, ADK_HUB_URL: API_STAGING };
  const comToken = (token: string) => ({ env: { ...env, ADK_TOKEN: token } });

  it('aud=adk não avisa: stderr vazio e saída 0', async () => {
    const result = await runCli(['whoami'], comToken(jwt({ aud: 'adk', email: 'a@b.c' })));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Audience: adk');
    expect(result.stderr).toBe('');
  });

  it('token sem aud (sessão do Hub) é aceito pelo Hub: stderr vazio', async () => {
    const result = await runCli(['whoami'], comToken(jwt({ sub: 'u1', email: 'a@b.c' })));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('aud diferente de adk avisa em pt-BR, sem jargão, e manda rodar adk login', async () => {
    const result = await runCli(['whoami'], comToken(jwt({ aud: 'mcp', email: 'a@b.c' })));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('"mcp"');
    expect(result.stderr).toContain('`adk plan`');
    expect(result.stderr).toContain('`adk deploy`');
    expect(result.stderr).toContain('`adk login`');
    expect(result.stderr).not.toMatch(/audience|401/i);
  });

  it('aud em array avisa, mesmo contendo adk (o Hub só aceita a string)', async () => {
    const result = await runCli(['whoami'], comToken(jwt({ aud: ['adk', 'mcp'] })));

    expect(result.stderr).toContain('"adk, mcp"');
    expect(result.stderr).toContain('`adk login`');
  });

  it('token ilegível tem aviso próprio e não fala de audience', async () => {
    const result = await runCli(['whoami'], comToken('abc.@@@.def'));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/não consegui ler este token/);
    expect(result.stderr).toContain('`adk login`');
  });

  it('com ADK_TOKEN no ambiente o aviso manda removê-lo', async () => {
    const result = await runCli(['whoami'], comToken(jwt({ aud: 'mcp' })));

    expect(result.stderr).toContain('Remova ADK_TOKEN');
  });

  it('credencial salva (sem ADK_TOKEN) com aud errado avisa, sem mandar remover ADK_TOKEN', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-whoami-'));
    try {
      await saveCredentials(
        { hubUrl: API_STAGING, configDir: dir },
        {
          client_id: 'c',
          redirect_uri: 'http://127.0.0.1:1/callback',
          refresh_token: 'r',
          access_token: jwt({ aud: 'mcp', email: 'a@b.c' }),
          expires_at: Date.now() + 3_600_000,
          user: 'a@b.c',
        },
      );
      const result = await runCli(['whoami'], {
        env: { ...env, ADK_TOKEN: undefined, ADK_CONFIG_DIR: dir },
      });

      expect(result.stderr).toContain('"mcp"');
      expect(result.stderr).not.toContain('ADK_TOKEN');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/**
 * `adk login --org <id>` (docs/adk-externo, ticket 03): o consentimento é pedido
 * só para aquela org. No AS do Hub (simplafy-hub-v2, apps/web
 * `app/(auth)/oauth/consent/page.tsx` e `api/oauth/authorize/route.ts`), a org
 * vai no parâmetro `org` do `/authorize`, e `org_scope=all` é o que liga o
 * "todas as orgs" — então com `--org` o pedido leva `org=<id>` e NÃO leva
 * `org_scope=all`.
 *
 * Como o teste chega à URL de autorização sem navegador: o registro do cliente
 * (DCR) responde um client_id; o handler, de posse do `redirect_uri` loopback,
 * dispara o callback com `state` errado — o login termina (exit 1) depois de
 * ter impresso a URL. `PATH` vazio impede o `xdg-open` de abrir um navegador
 * de verdade.
 */
describe('adk login --org — consentimento de uma org só', () => {
  const AS_PROD = 'https://app.simplafy.com.br/hub';
  const ORG = 'org-prd-bbb222';

  function encerrarPeloCallback() {
    server.use(
      http.post(`${AS_PROD}/api/oauth/register`, async ({ request }) => {
        const body = (await request.json()) as { redirect_uris: string[] };
        const callback = new URL(body.redirect_uris[0]!);
        callback.searchParams.set('code', 'x');
        callback.searchParams.set('state', 'estado-que-nao-confere');
        setImmediate(() => void fetch(callback).catch(() => undefined));
        return HttpResponse.json({
          client_id: 'client-teste',
          redirect_uris: body.redirect_uris,
          grant_types: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_method: 'none',
        });
      }),
    );
  }

  const ENV_LOGIN = {
    ADK_HUB_URL: undefined,
    ADK_AUTH_URL: undefined,
    ADK_PROFILE: undefined,
    ADK_TOKEN: undefined,
    PATH: '/caminho-inexistente-adk-teste',
  };

  function urlDeAutorizacao(stdout: string): URL {
    const bruta = stdout.match(/https:\/\/\S+\/api\/oauth\/authorize\S*/)?.[0];
    expect(bruta, 'a URL de autorização não foi impressa').toBeDefined();
    return new URL(bruta!);
  }

  it('com --org <id>, a URL de autorização pede a org e não pede todas', async () => {
    encerrarPeloCallback();

    const result = await runCli(['login', '--org', ORG], { env: ENV_LOGIN });

    const url = urlDeAutorizacao(result.stdout);
    expect(url.searchParams.get('org')).toBe(ORG);
    expect(url.searchParams.get('org_scope')).toBeNull();
  });

  it('sem --org, continua pedindo todas as orgs (org_scope=all) e nenhuma org fixa', async () => {
    encerrarPeloCallback();

    const result = await runCli(['login'], { env: ENV_LOGIN });

    const url = urlDeAutorizacao(result.stdout);
    expect(url.searchParams.get('org_scope')).toBe('all');
    expect(url.searchParams.get('org')).toBeNull();
  });
});
