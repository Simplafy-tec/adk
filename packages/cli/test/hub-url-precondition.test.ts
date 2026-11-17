import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// issue#2810 — `plan`/`apply` sem ADK_HUB_URL falhavam DENTRO do laço, uma vez
// por artefato: doze artefatos = doze linhas idênticas de
// "Defina ADK_HUB_URL com a base da API do Hub." (blocking hub_error, exit 1).
// A falta de ADK_HUB_URL é pré-condição da RODADA inteira, não daquele
// artefato — deve ser checada UMA VEZ, ao lado do guard de `--org`, com exit
// 2 (código de pré-condição) e uma única linha em stderr.

const HUB = 'http://hub-mock.test';
const ORG = 'org-staging-1';

let agentsPlanChamadas: unknown[] = [];

const server = setupServer(
  http.post(`${HUB}/api/v1/adk/tools/apply`, () =>
    HttpResponse.json({ plan: { action: 'create', blocking: [] }, applied: true }),
  ),
  http.post(`${HUB}/api/v1/adk/tools/plan`, () =>
    HttpResponse.json({ plan: { action: 'create', blocking: [] }, applied: false }),
  ),
  http.post(`${HUB}/api/v1/adk/agents/apply`, () =>
    HttpResponse.json({ plan: { action: 'noop', blocking: [] }, applied: true }),
  ),
  http.post(`${HUB}/api/v1/adk/agents/plan`, async ({ request }) => {
    agentsPlanChamadas.push(await request.json());
    return HttpResponse.json({ plan: { action: 'noop', blocking: [] }, applied: false });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  agentsPlanChamadas = [];
});
afterAll(() => server.close());

/** ≥3 artefatos — é o que faz a asserção "1, não N" valer alguma coisa. */
function orgFixtureComTresArtefatos(dir: string) {
  mkdirSync(join(dir, 'orgs', 'acme', 'tools'), { recursive: true });
  mkdirSync(join(dir, 'orgs', 'acme', 'agentes'), { recursive: true });
  writeFileSync(
    join(dir, 'orgs', 'acme', 'org.yaml'),
    ['environments:', `  staging: ${ORG}`].join('\n'),
  );
  writeFileSync(
    join(dir, 'orgs', 'acme', 'tools', 'tool-a.yaml'),
    ['spec_version: v1', 'kind: tool', 'slug: tool-a', 'definition:', '  name: tool_a'].join('\n'),
  );
  writeFileSync(
    join(dir, 'orgs', 'acme', 'tools', 'tool-b.yaml'),
    ['spec_version: v1', 'kind: tool', 'slug: tool-b', 'definition:', '  name: tool_b'].join('\n'),
  );
  writeFileSync(
    join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'),
    ['spec_version: v1', 'kind: agent', 'slug: ana', 'definition: {}'].join('\n'),
  );
}

function contarLinhasComEnv(texto: string): number {
  return texto.split('\n').filter((l) => l.includes('--env')).length;
}

// docs/adk-externo (ticket 01): sem ADK_HUB_URL a CLI usa o perfil `prod`, então
// "falta ADK_HUB_URL" deixou de ser pré-condição. O desenho da issue#2810 segue
// valendo para a pré-condição que sobrou — `--env` que contradiz o perfil: UMA
// linha só, antes do laço, nada de relatório por artefato.
const SEM_URL = { ADK_HUB_URL: undefined, ADK_AUTH_URL: undefined, ADK_PROFILE: undefined };

describe('adk plan/apply — pré-condição da rodada (issue#2810)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-hub-url-precondicao-'));
    orgFixtureComTresArtefatos(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('plan com --env divergente do perfil padrão falha com UMA única mensagem (não uma por artefato)', async () => {
    const result = await runCli(['plan', '--env', 'staging', '--org', ORG, '--dir', dir], {
      env: { ...SEM_URL, ADK_TOKEN: 'fake-token' },
    });
    expect(result.exitCode).toBe(2);
    expect(contarLinhasComEnv(result.stdout + result.stderr)).toBe(1);
    expect(agentsPlanChamadas).toHaveLength(0);
  });

  it('apply (deploy) com --env divergente do perfil padrão falha com UMA única mensagem', async () => {
    const result = await runCli(['apply', '--env', 'staging', '--org', ORG, '--dir', dir], {
      env: { ...SEM_URL, ADK_TOKEN: 'fake-token' },
    });
    expect(result.exitCode).toBe(2);
    expect(contarLinhasComEnv(result.stdout + result.stderr)).toBe(1);
  });

  it('--json também produz UMA mensagem em stderr — nada de JSON na saída (mesmo desenho do guard de --org)', async () => {
    const result = await runCli(
      ['plan', '--env', 'staging', '--org', ORG, '--dir', dir, '--json'],
      { env: { ...SEM_URL, ADK_TOKEN: 'fake-token' } },
    );
    expect(result.exitCode).toBe(2);
    expect(contarLinhasComEnv(result.stdout + result.stderr)).toBe(1);
    expect(() => JSON.parse(result.stdout)).toThrow();
  });

  it('COM ADK_HUB_URL definida, o relatório por artefato não muda — 3 artefatos reportados normalmente', async () => {
    const result = await runCli(
      ['plan', '--env', 'staging', '--org', ORG, '--dir', dir, '--json'],
      { env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' } },
    );
    expect(result.exitCode).toBe(0);
    const relatorio = JSON.parse(result.stdout);
    expect(relatorio.artefatos).toHaveLength(3);
  });

  it('COM ADK_HUB_URL definida, falha de rede/credencial do Hub continua tratada POR ARTEFATO (catch existente, não sacrificado)', async () => {
    server.use(
      http.post(`${HUB}/api/v1/adk/tools/plan`, () => HttpResponse.error()),
    );
    const result = await runCli(
      ['plan', '--env', 'staging', '--org', ORG, '--dir', dir, '--json'],
      { env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' } },
    );
    const relatorio = JSON.parse(result.stdout);
    // As duas tools falham no Hub, mas o agente (que não depende do mock quebrado) segue reportado.
    const agente = relatorio.artefatos.find((a: { arquivo: string }) => a.arquivo === 'ana.yaml');
    expect(agente).toBeDefined();
    const toolA = relatorio.artefatos.find((a: { arquivo: string }) => a.arquivo === 'tool-a.yaml');
    expect(toolA.blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'hub_error' })]),
    );
  });

  it('adk validate sem ADK_HUB_URL continua funcionando 100% offline (não exige a env, nunca sai com 2 por pré-condição)', async () => {
    const result = await runCli(['validate', '--dir', dir], {
      env: { ADK_HUB_URL: undefined },
    });
    expect(result.exitCode).not.toBe(2);
    expect([0, 1]).toContain(result.exitCode);
  });
});

// Caminho prompt→scanLeaks→plan (issue#2808 exercitado via CLI): o portão de
// prompt roda ANTES da chamada ao Hub, então o placeholder deixa de bloquear
// e o valor real continua bloqueando e nunca é enviado.
describe('adk plan — prompt com turn_context (issue#2808 via CLI)', () => {
  let dir: string;

  function orgComAgentePrompt(promptTexto: string) {
    mkdirSync(join(dir, 'orgs', 'acme', 'agentes'), { recursive: true });
    writeFileSync(
      join(dir, 'orgs', 'acme', 'org.yaml'),
      ['environments:', `  staging: ${ORG}`].join('\n'),
    );
    writeFileSync(join(dir, 'orgs', 'acme', 'agentes', 'prompt.txt'), promptTexto);
    writeFileSync(
      join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'),
      [
        'spec_version: v1',
        'kind: agent',
        'slug: ana',
        'prompt_file: prompt.txt',
        'definition:',
        '  name: ana',
      ].join('\n'),
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-prompt-turn-context-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prompt com placeholder <oap_contact_phone> não é bloqueado por turn_context e vai ao Hub', async () => {
    orgComAgentePrompt('Você é a Ana. Envie para <oap_contact_phone>.\n');
    const result = await runCli(
      ['plan', '--env', 'staging', '--org', ORG, '--dir', dir, '--json'],
      { env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' } },
    );
    const relatorio = JSON.parse(result.stdout);
    const linha = relatorio.artefatos.find((a: { arquivo: string }) => a.arquivo === 'ana.yaml');
    expect(linha.blocking.find((b: { code: string }) => b.code === 'turn_context')).toBeUndefined();
    expect(agentsPlanChamadas).toHaveLength(1);
  });

  it('prompt com oap_contact_phone: +55 11 99999-9999 é bloqueado por turn_context e NÃO vai ao Hub', async () => {
    orgComAgentePrompt('Você é a Ana.\noap_contact_phone: +55 11 99999-9999\n');
    const result = await runCli(
      ['plan', '--env', 'staging', '--org', ORG, '--dir', dir, '--json'],
      { env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' } },
    );
    const relatorio = JSON.parse(result.stdout);
    const linha = relatorio.artefatos.find((a: { arquivo: string }) => a.arquivo === 'ana.yaml');
    expect(linha.blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'turn_context' })]),
    );
    expect(agentsPlanChamadas).toHaveLength(0);
  });
});
