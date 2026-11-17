import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { parse } from 'yaml';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

/**
 * `adk init org` (docs/adk-externo, ticket 03): gera a pasta de uma org que já
 * existe no Hub, para o externo começar a versionar sem escrever YAML à mão.
 *
 * Interface esperada:
 *   adk init org [--org <id>] [--dir <raiz do repositório de clientes>]
 * - lista as orgs do token (as mesmas do `adk orgs`, claim `orgs`);
 * - cria `orgs/<pasta>/org.yaml` com `environments.<ambiente do perfil>: <id>`;
 * - roda o `export` da org em seguida.
 * O nome da pasta não é fixado aqui (decisão do dev): o teste acha o único
 * `orgs/<pasta>/org.yaml` criado.
 *
 * O Hub é falso (msw) no host de produção, que é o perfil padrão — nada sai
 * para a rede (guarda da suíte).
 */

const API_PROD = 'https://api-hub-v2.simplafy.com.br';
const API_STAGING = 'https://api-hub-v2-staging.simplafy.com.br';

const ORG_A = 'org-prd-aaa111';
const ORG_B = 'org-prd-bbb222';

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.assinatura`;
}

/** Token de quem administra DUAS orgs — a escolhida é a segunda, não a primeira. */
const TOKEN = jwt({
  aud: 'adk',
  email: 'integrador@cliente.com',
  orgs: [
    { orgId: ORG_A, role: 'ADMIN' },
    { orgId: ORG_B, role: 'ADMIN' },
  ],
});

const TOOL_YAML = [
  'spec_version: v1',
  'kind: tool',
  'slug: consulta-cep',
  'definition:',
  '  name: consulta_cep',
  '',
].join('\n');

/** `<origem><caminho>?orgId=` de cada chamada ao Hub falso. */
const chamadas: string[] = [];

const server = setupServer(
  ...[API_PROD, API_STAGING].flatMap((hub) => [
    ...(['tools', 'agents', 'journeys'] as const).map((rota) =>
      http.get(`${hub}/api/v1/adk/${rota}/export`, ({ request }) => {
        const url = new URL(request.url);
        chamadas.push(`${url.origin}${url.pathname}?orgId=${url.searchParams.get('orgId')}`);
        const items = rota === 'tools' ? [{ slug: 'consulta-cep', yaml: TOOL_YAML }] : [];
        return HttpResponse.json({ kind: rota.slice(0, -1), items, skipped: [] });
      }),
    ),
    http.post(`${hub}/api/v1/adk/tools/plan`, ({ request }) => {
      const url = new URL(request.url);
      chamadas.push(`${url.origin}${url.pathname}?orgId=${url.searchParams.get('orgId')}`);
      return HttpResponse.json({ action: 'noop', changes: [], blocking: [] });
    }),
  ]),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  chamadas.length = 0;
});
afterAll(() => server.close());

const ENV = { ADK_HUB_URL: undefined, ADK_AUTH_URL: undefined, ADK_PROFILE: undefined, ADK_TOKEN: TOKEN };

function orgYamlsCriados(raiz: string): string[] {
  const orgs = join(raiz, 'orgs');
  if (!existsSync(orgs)) return [];
  return readdirSync(orgs)
    .map((pasta) => join(orgs, pasta, 'org.yaml'))
    .filter((p) => existsSync(p));
}

describe('adk init org', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-init-org-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('com --org', () => {
    it('cria um único orgs/<pasta>/org.yaml com environments.production = id escolhido', async () => {
      const result = await runCli(['init', 'org', '--org', ORG_B, '--dir', dir], {
        cwd: dir,
        env: ENV,
      });

      expect(result.exitCode).toBe(0);
      const criados = orgYamlsCriados(dir);
      expect(criados).toHaveLength(1);
      const doc = parse(readFileSync(criados[0]!, 'utf8')) as { environments?: Record<string, string> };
      expect(doc.environments).toEqual({ production: ORG_B });
    });

    it('roda o export da org escolhida na mesma pasta', async () => {
      await runCli(['init', 'org', '--org', ORG_B, '--dir', dir], { cwd: dir, env: ENV });

      expect(chamadas).toContain(`${API_PROD}/api/v1/adk/tools/export?orgId=${ORG_B}`);
      const criados = orgYamlsCriados(dir);
      expect(criados).toHaveLength(1);
      const pasta = join(criados[0]!, '..');
      expect(readFileSync(join(pasta, 'tools', 'consulta-cep.yaml'), 'utf8')).toContain(
        'slug: consulta-cep',
      );
    });

    it('com ADK_PROFILE=staging, declara environments.staging e exporta do Hub de staging', async () => {
      await runCli(['init', 'org', '--org', ORG_B, '--dir', dir], {
        cwd: dir,
        env: { ...ENV, ADK_PROFILE: 'staging' },
      });

      const criados = orgYamlsCriados(dir);
      expect(criados).toHaveLength(1);
      const doc = parse(readFileSync(criados[0]!, 'utf8')) as { environments?: Record<string, string> };
      expect(doc.environments).toEqual({ staging: ORG_B });
      expect(chamadas).toContain(`${API_STAGING}/api/v1/adk/tools/export?orgId=${ORG_B}`);
    });

    it('o org.yaml gerado passa no adk plan: a tool exportada vai ao Hub com o id da org', async () => {
      await runCli(['init', 'org', '--org', ORG_B, '--dir', dir], { cwd: dir, env: ENV });
      chamadas.length = 0;

      const plan = await runCli(['plan', '--org', ORG_B, '--dir', dir, '--json'], { cwd: dir, env: ENV });

      expect(plan.exitCode).toBe(0);
      expect(chamadas).toEqual([`${API_PROD}/api/v1/adk/tools/plan?orgId=${ORG_B}`]);
    });

    it('o org.yaml gerado passa no adk validate (amarração de tenant e vazamento)', async () => {
      await runCli(['init', 'org', '--org', ORG_B, '--dir', dir], { cwd: dir, env: ENV });
      expect(orgYamlsCriados(dir)).toHaveLength(1);

      const validate = await runCli(['validate', '--dir', dir, '--json'], { cwd: dir, env: ENV });

      const { artefatos } = JSON.parse(validate.stdout) as {
        artefatos: { kind: string; issues: unknown[] }[];
      };
      expect(artefatos.filter((a) => a.kind === 'org')).toEqual([]);
    });
  });

  describe('recusas com --org', () => {
    it('--org fora do token sai com 2 listando as orgs disponíveis, sem criar pasta nem chamar o Hub', async () => {
      const result = await runCli(['init', 'org', '--org', 'org-alheia-zzz', '--dir', dir], {
        cwd: dir,
        env: ENV,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('org-alheia-zzz');
      expect(result.stderr).toContain(ORG_A);
      expect(result.stderr).toContain(ORG_B);
      expect(orgYamlsCriados(dir)).toEqual([]);
      expect(chamadas).toEqual([]);
    });

    it('outra pasta já declara o id no mesmo ambiente: sai com 1 e não cria segunda pasta', async () => {
      mkdirSync(join(dir, 'orgs', 'existente'), { recursive: true });
      const yamlOriginal = `environments:\n  production: ${ORG_B}\n`;
      writeFileSync(join(dir, 'orgs', 'existente', 'org.yaml'), yamlOriginal);

      const result = await runCli(['init', 'org', '--org', ORG_B, '--dir', dir], { cwd: dir, env: ENV });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('orgs/existente');
      expect(readdirSync(join(dir, 'orgs'))).toEqual(['existente']);
      expect(readFileSync(join(dir, 'orgs', 'existente', 'org.yaml'), 'utf8')).toBe(yamlOriginal);
      expect(chamadas).toEqual([]);
    });

    it('orgs/<pasta> pedida já existe (de outra org): sai com 1 e não mexe no org.yaml dela', async () => {
      mkdirSync(join(dir, 'orgs', 'ocupada'), { recursive: true });
      const yamlOriginal = `environments:\n  production: ${ORG_A}\n`;
      writeFileSync(join(dir, 'orgs', 'ocupada', 'org.yaml'), yamlOriginal);

      const result = await runCli(['init', 'org', 'ocupada', '--org', ORG_B, '--dir', dir], {
        cwd: dir,
        env: ENV,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('orgs/ocupada');
      expect(readdirSync(join(dir, 'orgs'))).toEqual(['ocupada']);
      expect(readFileSync(join(dir, 'orgs', 'ocupada', 'org.yaml'), 'utf8')).toBe(yamlOriginal);
      expect(chamadas).toEqual([]);
    });
  });

  describe('sem --org, num TTY', () => {
    it('a escolha numerada "2" cria o org.yaml da SEGUNDA org e exporta dela', async () => {
      const stdin = Object.assign(new PassThrough(), { isTTY: true });
      stdin.end('2\n');
      const result = await runCli(['init', 'org', '--dir', dir], { cwd: dir, env: ENV, stdin });

      expect(result.exitCode).toBe(0);
      const criados = orgYamlsCriados(dir);
      expect(criados).toHaveLength(1);
      const doc = parse(readFileSync(criados[0]!, 'utf8')) as { environments?: Record<string, string> };
      expect(doc.environments).toEqual({ production: ORG_B });
      expect(chamadas).toContain(`${API_PROD}/api/v1/adk/tools/export?orgId=${ORG_B}`);
      expect(chamadas.some((c) => c.includes(ORG_A))).toBe(false);
    });
  });

  describe('sem --org', () => {
    it('lista as orgs do token e, fora de TTY, sai com 2 sem criar pasta', async () => {
      // `stdin` explícito e não-TTY: mesma interface do ticket 02 (apply).
      const stdin = Object.assign(new PassThrough(), { isTTY: false });
      stdin.end();
      const result = await runCli(['init', 'org', '--dir', dir], { cwd: dir, env: ENV, stdin });

      const saida = result.stdout + result.stderr;
      expect(saida).toContain(ORG_A);
      expect(saida).toContain(ORG_B);
      expect(result.exitCode).toBe(2);
      expect(orgYamlsCriados(dir)).toEqual([]);
    });
  });
});
