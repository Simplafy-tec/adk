import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { saveCredentials } from '../src/credentials.js';
import { runCli } from '../src/cli.js';

/**
 * Perfis de ambiente embutidos na CLI (docs/adk-externo, ticket 01).
 *
 * Quem só tem e-mail e senha de produção roda `adk login`/`adk plan` sem
 * configurar URL nenhuma: o perfil `prod` é o padrão. A equipe interna escolhe
 * `staging` por `--profile staging` ou `ADK_PROFILE=staging`. `ADK_HUB_URL` e
 * `ADK_AUTH_URL` continuam valendo como override, com precedência sobre o
 * perfil. O `--env` de `plan`/`apply` deixa de ter padrão fixo (`staging`) e
 * passa a ser derivado do perfil.
 *
 * Os testes assertam ONDE a chamada chegou (host da API ou do AS) e QUAL
 * pasta de org foi escolhida — é o efeito que separa "resolveu o perfil" de
 * "caiu num padrão qualquer".
 *
 * Hosts reais, conferidos na infra:
 *   API prod     <repo-infra>/apps/<no-prod-a>/custom/simplafy-hub-v2/manifests/api-deployment.yaml:640
 *   AS prod      <repo-infra>/apps/<no-prod-b>/custom/simplafy-hub-v2/manifests/mcp-deployment.yaml:74
 *                (OAUTH_ISSUER; basePath /hub em simplafy-hub-v2/apps/web/next.config.ts:107)
 *   API staging  <repo-infra>/apps/<no-staging>/custom/simplafy-hub-v2/manifests/api-deployment.yaml:818
 *   AS staging   <repo-infra>/apps/<no-staging>/custom/simplafy-hub-v2/manifests/mcp-deployment.yaml:75
 */

const API_PROD = 'https://api-hub-v2.simplafy.com.br';
const AS_PROD = 'https://app.simplafy.com.br/hub';
const API_STAGING = 'https://api-hub-v2-staging.simplafy.com.br';
const AS_STAGING = 'https://app-staging.simplafy.com.br/hub';
const HUB_OVERRIDE = 'http://hub-override.test';
const AS_OVERRIDE = 'http://as-override.test/hub';

const ORG_PRD = 'org-prod-a';
const ORG_STG = 'org-stg-1';

/** URL de cada chamada que chegou a um Hub ou AS mockado. */
const chamadas: string[] = [];

function registrar(request: Request) {
  chamadas.push(request.url);
}

const planoNoop = () =>
  HttpResponse.json({ plan: { action: 'noop', blocking: [] }, applied: false });

const server = setupServer(
  // O registro do cliente responde 400 de propósito: o teste só precisa saber
  // EM QUAL AS ele chegou, e falhar aqui encerra o login sem abrir navegador
  // nem esperar callback.
  ...[AS_PROD, AS_STAGING, AS_OVERRIDE].map((as) =>
    http.post(`${as}/api/oauth/register`, ({ request }) => {
      registrar(request);
      return HttpResponse.json({ error: 'invalid_client_metadata' }, { status: 400 });
    }),
  ),
  ...[API_PROD, API_STAGING, HUB_OVERRIDE].map((hub) =>
    http.post(`${hub}/api/v1/adk/tools/plan`, ({ request }) => {
      registrar(request);
      return planoNoop();
    }),
  ),
  ...[API_PROD, API_STAGING, HUB_OVERRIDE].map((hub) =>
    http.post(`${hub}/api/v1/adk/tools/apply`, ({ request }) => {
      registrar(request);
      return HttpResponse.json({ plan: { action: 'update', blocking: [] }, applied: true });
    }),
  ),
  // `export` lê os três kinds; só `tools` traz um item, para o arquivo escrito
  // dizer em QUAL pasta (ambiente) o export caiu.
  ...[API_PROD, API_STAGING, HUB_OVERRIDE].flatMap((hub) =>
    (['tools', 'agents', 'journeys'] as const).map((rota) =>
      http.get(`${hub}/api/v1/adk/${rota}/export`, ({ request }) => {
        registrar(request);
        const items =
          rota === 'tools'
            ? [{ slug: 'tool-exportada', yaml: 'spec_version: v1\nkind: tool\nslug: tool-exportada\n' }]
            : [];
        return HttpResponse.json({ kind: rota.slice(0, -1), items, skipped: [] });
      }),
    ),
  ),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  chamadas.length = 0;
});
afterAll(() => server.close());

// `runCli` mescla `process.env`: sem anular aqui, um ADK_* do shell de quem
// roda a suíte mascararia o perfil padrão.
const LIMPO = {
  ADK_HUB_URL: undefined,
  ADK_AUTH_URL: undefined,
  ADK_PROFILE: undefined,
  ADK_TOKEN: undefined,
};

function hostsChamados(): string[] {
  return chamadas.map((u) => new URL(u).origin);
}

describe('adk login — servidor de autorização por perfil', () => {
  it('sem nenhuma variável, registra o cliente no AS de produção (app.simplafy.com.br/hub)', async () => {
    await runCli(['login'], { env: { ...LIMPO } });

    expect(chamadas).toEqual([`${AS_PROD}/api/oauth/register`]);
  });

  it('com ADK_PROFILE=staging, registra no AS de staging', async () => {
    await runCli(['login'], { env: { ...LIMPO, ADK_PROFILE: 'staging' } });

    expect(chamadas).toEqual([`${AS_STAGING}/api/oauth/register`]);
  });

  it('com --profile staging, registra no AS de staging', async () => {
    await runCli(['login', '--profile', 'staging'], { env: { ...LIMPO } });

    expect(chamadas).toEqual([`${AS_STAGING}/api/oauth/register`]);
  });

  it('ADK_AUTH_URL tem precedência sobre o perfil', async () => {
    await runCli(['login'], {
      env: { ...LIMPO, ADK_PROFILE: 'staging', ADK_AUTH_URL: AS_OVERRIDE },
    });

    expect(chamadas).toEqual([`${AS_OVERRIDE}/api/oauth/register`]);
  });
});

describe('adk whoami — Hub resolvido pelo perfil', () => {
  it('sem nenhuma variável, mostra o Hub de produção', async () => {
    const result = await runCli(['whoami'], { env: { ...LIMPO, ADK_TOKEN: 'sk_teste_123456' } });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Hub:     ${API_PROD}`);
  });

  it('lê a credencial salva para o Hub de produção, sem ADK_HUB_URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adk-perfil-cred-'));
    try {
      await saveCredentials(
        { hubUrl: API_PROD, configDir: dir },
        {
          client_id: 'c',
          redirect_uri: 'http://127.0.0.1:1/callback',
          refresh_token: 'r',
          access_token: jwt({ aud: 'adk', email: 'integrador@cliente.com' }),
          expires_at: Date.now() + 3_600_000,
          user: 'integrador@cliente.com',
        },
      );
      const result = await runCli(['whoami'], { env: { ...LIMPO, ADK_CONFIG_DIR: dir } });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('integrador@cliente.com');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ADK_HUB_URL tem precedência sobre ADK_PROFILE', async () => {
    const result = await runCli(['whoami'], {
      env: { ...LIMPO, ADK_PROFILE: 'staging', ADK_HUB_URL: HUB_OVERRIDE, ADK_TOKEN: 'sk_teste_123456' },
    });

    expect(result.stdout).toContain(`Hub:     ${HUB_OVERRIDE}`);
  });
});

describe('adk plan/apply — perfil escolhe o Hub e deriva o --env', () => {
  let dir: string;

  /**
   * Uma org com ids DIFERENTES por ambiente: é o que faz o `--env` derivado
   * ser observável — com o ambiente errado, nenhuma pasta declara o `--org`
   * e nada vai ao Hub.
   */
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-perfil-plan-'));
    mkdirSync(join(dir, 'orgs', 'acme', 'tools'), { recursive: true });
    writeFileSync(
      join(dir, 'orgs', 'acme', 'org.yaml'),
      ['environments:', `  staging: ${ORG_STG}`, `  production: ${ORG_PRD}`].join('\n'),
    );
    writeFileSync(
      join(dir, 'orgs', 'acme', 'tools', 'tool-a.yaml'),
      ['spec_version: v1', 'kind: tool', 'slug: tool-a', 'definition:', '  name: tool_a'].join('\n'),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const comToken = (extra: Record<string, string | undefined> = {}) => ({
    env: { ...LIMPO, ADK_TOKEN: 'fake-token', ...extra },
  });

  describe('perfil padrão (prod)', () => {
    it('sem --env e sem variáveis, planeja a org de production no Hub de produção', async () => {
      const result = await runCli(['plan', '--org', ORG_PRD, '--dir', dir, '--json'], comToken());

      expect(result.exitCode).toBe(0);
      expect(hostsChamados()).toEqual([API_PROD]);
    });

    it('--env production explícito, coerente com o perfil, é aceito', async () => {
      const result = await runCli(
        ['plan', '--env', 'production', '--org', ORG_PRD, '--dir', dir, '--json'],
        comToken(),
      );

      expect(result.exitCode).toBe(0);
      expect(hostsChamados()).toEqual([API_PROD]);
    });
  });

  describe('perfil staging', () => {
    it('ADK_PROFILE=staging sem --env planeja a org de staging no Hub de staging', async () => {
      const result = await runCli(
        ['plan', '--org', ORG_STG, '--dir', dir, '--json'],
        comToken({ ADK_PROFILE: 'staging' }),
      );

      expect(result.exitCode).toBe(0);
      expect(hostsChamados()).toEqual([API_STAGING]);
    });

    it('--profile staging sem --env planeja a org de staging no Hub de staging', async () => {
      const result = await runCli(
        ['plan', '--profile', 'staging', '--org', ORG_STG, '--dir', dir, '--json'],
        comToken(),
      );

      expect(result.exitCode).toBe(0);
      expect(hostsChamados()).toEqual([API_STAGING]);
    });

    it('ADK_HUB_URL com perfil staging vai ao override e deriva --env staging do perfil', async () => {
      const result = await runCli(
        ['plan', '--org', ORG_STG, '--dir', dir, '--json'],
        comToken({ ADK_PROFILE: 'staging', ADK_HUB_URL: HUB_OVERRIDE }),
      );

      expect(result.exitCode).toBe(0);
      expect(hostsChamados()).toEqual([HUB_OVERRIDE]);
    });
  });

  describe('--env divergente do perfil', () => {
    it('perfil padrão (prod) com --env staging é erro claro e nada vai ao Hub', async () => {
      const result = await runCli(
        ['plan', '--env', 'staging', '--org', ORG_STG, '--dir', dir, '--json'],
        comToken(),
      );

      expect(result.exitCode).toBe(2);
      expect(chamadas).toEqual([]);
      expect(result.stderr).toContain('--env');
      expect(result.stderr).toContain('staging');
      expect(result.stderr).toMatch(/prod/);
    });

    it('perfil staging com --env production é erro claro e nada vai ao Hub', async () => {
      const result = await runCli(
        ['plan', '--env', 'production', '--org', ORG_PRD, '--dir', dir, '--json'],
        comToken({ ADK_PROFILE: 'staging' }),
      );

      expect(result.exitCode).toBe(2);
      expect(chamadas).toEqual([]);
      expect(result.stderr).toContain('--env');
      expect(result.stderr).toContain('production');
    });

    it('apply com --env divergente também é recusado antes de qualquer chamada', async () => {
      const result = await runCli(
        ['apply', '--env', 'production', '--org', ORG_PRD, '--dir', dir, '--json'],
        comToken({ ADK_PROFILE: 'staging' }),
      );

      expect(result.exitCode).toBe(2);
      expect(chamadas).toEqual([]);
      expect(result.stderr).toContain('--env');
    });
  });

  describe('override de URL sem perfil', () => {
    it('ADK_HUB_URL sem perfil e sem --env é erro que pede o --env, e nada vai ao Hub', async () => {
      const result = await runCli(
        ['plan', '--org', ORG_STG, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: HUB_OVERRIDE }),
      );

      expect(result.exitCode).toBe(2);
      expect(chamadas).toEqual([]);
      expect(result.stderr).toContain('--env');
    });

    it('ADK_HUB_URL sem perfil e com --env explícito vai ao override com aquele ambiente', async () => {
      const result = await runCli(
        ['plan', '--env', 'production', '--org', ORG_PRD, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: HUB_OVERRIDE }),
      );

      expect(result.exitCode).toBe(0);
      expect(hostsChamados()).toEqual([HUB_OVERRIDE]);
    });
  });
});

/** Repositório com a org `acme`, ids diferentes por ambiente (ver o describe de plan/apply). */
function repoAcme(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adk-perfil-host-'));
  mkdirSync(join(dir, 'orgs', 'acme', 'tools'), { recursive: true });
  writeFileSync(
    join(dir, 'orgs', 'acme', 'org.yaml'),
    ['environments:', `  staging: ${ORG_STG}`, `  production: ${ORG_PRD}`].join('\n'),
  );
  writeFileSync(
    join(dir, 'orgs', 'acme', 'tools', 'tool-a.yaml'),
    ['spec_version: v1', 'kind: tool', 'slug: tool-a', 'definition:', '  name: tool_a'].join('\n'),
  );
  return dir;
}

/**
 * Revisão do ticket 01: `ADK_HUB_URL` com um host CONHECIDO da API do Hub diz
 * o ambiente sozinho. O roteiro interno de QA (simplafy-clientes/QA-STAGING.md)
 * exporta só `ADK_HUB_URL=https://api-hub-v2-staging…` e roda `adk plan`/`apply`
 * sem `--env` — com o perfil `prod` padrão, isso não pode virar nem erro de
 * "informe --env" nem, pior, a org de PRODUÇÃO planejada no Hub de staging.
 *
 * Perfil (`--profile`/`ADK_PROFILE`) ou `--env` que contradiga o host é
 * pré-condição da rodada: exit 2 e nada chega a Hub nenhum.
 */
describe('ADK_HUB_URL de host conhecido deduz o ambiente', () => {
  let dir: string;

  beforeEach(() => {
    dir = repoAcme();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const comToken = (extra: Record<string, string | undefined>) => ({
    env: { ...LIMPO, ADK_TOKEN: 'fake-token', ...extra },
  });

  describe('host coerente', () => {
    it('ADK_HUB_URL de staging, sem perfil e sem --env, planeja a org de staging no Hub de staging', async () => {
      const result = await runCli(
        ['plan', '--org', ORG_STG, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: API_STAGING }),
      );

      expect(result.exitCode).toBe(0);
      expect(hostsChamados()).toEqual([API_STAGING]);
    });

    it('ADK_HUB_URL de staging com barra final ainda é reconhecido como staging', async () => {
      const result = await runCli(
        ['plan', '--org', ORG_STG, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: `${API_STAGING}/` }),
      );

      expect(result.exitCode).toBe(0);
      expect(hostsChamados()).toEqual([API_STAGING]);
    });

    it('apply com ADK_HUB_URL de staging e sem --env aplica a org de staging (roteiro de QA)', async () => {
      const result = await runCli(
        ['apply', '--org', ORG_STG, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: API_STAGING }),
      );

      expect(result.exitCode).toBe(0);
      expect(chamadas).toEqual([`${API_STAGING}/api/v1/adk/tools/apply?orgId=${ORG_STG}`]);
    });

    it('ADK_HUB_URL de produção, sem perfil e sem --env, planeja a org de production', async () => {
      const result = await runCli(
        ['plan', '--org', ORG_PRD, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: API_PROD }),
      );

      expect(result.exitCode).toBe(0);
      expect(hostsChamados()).toEqual([API_PROD]);
    });

    it('ADK_HUB_URL de staging com --profile staging (coerente) é aceito', async () => {
      const result = await runCli(
        ['plan', '--profile', 'staging', '--org', ORG_STG, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: API_STAGING }),
      );

      expect(result.exitCode).toBe(0);
      expect(hostsChamados()).toEqual([API_STAGING]);
    });
  });

  describe('perfil ou --env que contradiz o host', () => {
    it('--profile prod com ADK_HUB_URL de staging sai com 2 e nada vai ao Hub', async () => {
      const result = await runCli(
        ['plan', '--profile', 'prod', '--org', ORG_PRD, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: API_STAGING }),
      );

      expect(result.exitCode).toBe(2);
      expect(chamadas).toEqual([]);
      expect(result.stderr).toContain('ADK_HUB_URL');
    });

    it('ADK_PROFILE=prod com ADK_HUB_URL de staging sai com 2 e nada vai ao Hub', async () => {
      const result = await runCli(
        ['plan', '--org', ORG_PRD, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: API_STAGING, ADK_PROFILE: 'prod' }),
      );

      expect(result.exitCode).toBe(2);
      expect(chamadas).toEqual([]);
    });

    it('ADK_PROFILE=staging com ADK_HUB_URL de produção sai com 2 e nada vai ao Hub', async () => {
      const result = await runCli(
        ['plan', '--org', ORG_STG, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: API_PROD, ADK_PROFILE: 'staging' }),
      );

      expect(result.exitCode).toBe(2);
      expect(chamadas).toEqual([]);
      expect(result.stderr).toContain('ADK_HUB_URL');
    });

    it('--env production com ADK_HUB_URL de staging (sem perfil) sai com 2 e nada vai ao Hub', async () => {
      const result = await runCli(
        ['plan', '--env', 'production', '--org', ORG_PRD, '--dir', dir, '--json'],
        comToken({ ADK_HUB_URL: API_STAGING }),
      );

      expect(result.exitCode).toBe(2);
      expect(chamadas).toEqual([]);
      expect(result.stderr).toContain('--env');
    });

    it('adk login com --profile prod e ADK_HUB_URL de staging sai com 2 sem registrar cliente em AS nenhum', async () => {
      const result = await runCli(['login', '--profile', 'prod'], {
        env: { ...LIMPO, ADK_HUB_URL: API_STAGING },
      });

      expect(result.exitCode).toBe(2);
      expect(chamadas).toEqual([]);
    });
  });

  it('export com ADK_HUB_URL de produção e sem --env escreve na pasta da org de production', async () => {
    const result = await runCli(
      ['export', '--org', ORG_PRD, '--dir', dir, '--kind', 'tool'],
      comToken({ ADK_HUB_URL: API_PROD }),
    );

    expect(result.exitCode).toBe(0);
    expect(existsSync(join(dir, 'orgs', 'acme', 'tools', 'tool-exportada.yaml'))).toBe(true);
  });
});

describe('perfil desconhecido', () => {
  let dir: string;

  beforeEach(() => {
    dir = repoAcme();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('--profile foo sai com 2, lista prod e staging, e nada vai ao Hub', async () => {
    const result = await runCli(['plan', '--profile', 'foo', '--org', ORG_PRD, '--dir', dir], {
      env: { ...LIMPO, ADK_TOKEN: 'fake-token' },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/\bprod\b/);
    expect(result.stderr).toMatch(/\bstaging\b/);
    expect(chamadas).toEqual([]);
  });

  it('ADK_PROFILE=production (nome de ambiente, não de perfil) sai com 2 e nada vai ao Hub', async () => {
    const result = await runCli(['plan', '--org', ORG_PRD, '--dir', dir], {
      env: { ...LIMPO, ADK_TOKEN: 'fake-token', ADK_PROFILE: 'production' },
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('production');
    expect(result.stderr).toMatch(/prod\s*\|\s*staging/);
    expect(chamadas).toEqual([]);
  });

  it('perfil desconhecido também barra o login antes de registrar cliente', async () => {
    const result = await runCli(['login', '--profile', 'foo'], { env: { ...LIMPO } });

    expect(result.exitCode).toBe(2);
    expect(chamadas).toEqual([]);
  });
});

describe('adk export — ambiente derivado do perfil', () => {
  let dir: string;

  beforeEach(() => {
    dir = repoAcme();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const arquivoExportado = () => join(dir, 'orgs', 'acme', 'tools', 'tool-exportada.yaml');

  it('sem perfil e sem --env, exporta a org de production do Hub de produção', async () => {
    const result = await runCli(['export', '--org', ORG_PRD, '--dir', dir, '--kind', 'tool'], {
      env: { ...LIMPO, ADK_TOKEN: 'fake-token' },
    });

    expect(result.exitCode).toBe(0);
    expect(chamadas).toEqual([`${API_PROD}/api/v1/adk/tools/export?orgId=${ORG_PRD}`]);
    expect(existsSync(arquivoExportado())).toBe(true);
  });

  it('com ADK_PROFILE=staging e sem --env, exporta a org de staging do Hub de staging', async () => {
    const result = await runCli(['export', '--org', ORG_STG, '--dir', dir, '--kind', 'tool'], {
      env: { ...LIMPO, ADK_TOKEN: 'fake-token', ADK_PROFILE: 'staging' },
    });

    expect(result.exitCode).toBe(0);
    expect(chamadas).toEqual([`${API_STAGING}/api/v1/adk/tools/export?orgId=${ORG_STG}`]);
    expect(existsSync(arquivoExportado())).toBe(true);
  });

  it('perfil padrão com --env staging divergente sai com 2, sem chamada e sem arquivo', async () => {
    const result = await runCli(
      ['export', '--env', 'staging', '--org', ORG_STG, '--dir', dir, '--kind', 'tool'],
      { env: { ...LIMPO, ADK_TOKEN: 'fake-token' } },
    );

    expect(result.exitCode).toBe(2);
    expect(chamadas).toEqual([]);
    expect(existsSync(arquivoExportado())).toBe(false);
  });
});

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.assinatura`;
}
