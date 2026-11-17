import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// Revogação declarada de vínculo agente↔tool (`tools_remover`). O plano do Hub
// devolve `toolRevocations: [{name, declared?, action: 'remove' | 'noop'}]`
// sempre que o arquivo declara `tools_remover`; a CLI mostra cada `remove` como
// linha própria e falha fechado quando o Hub não ecoa o campo (Hub antigo
// ignoraria a chave e diria "sem alteração" com o vínculo ainda concedendo a tool).

const HUB = 'http://hub-mock.test';
const ORG = 'org-staging-1';

let respostaDoPlano: Record<string, unknown>;
let chamadas: { plan: number; apply: number };

const server = setupServer(
  http.post(`${HUB}/api/v1/adk/agents/plan`, () => {
    chamadas.plan += 1;
    return HttpResponse.json(respostaDoPlano);
  }),
  http.post(`${HUB}/api/v1/adk/agents/apply`, () => {
    chamadas.apply += 1;
    return HttpResponse.json({ plan: respostaDoPlano, applied: true });
  }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

let dir: string;
beforeEach(() => {
  chamadas = { plan: 0, apply: 0 };
  dir = mkdtempSync(join(tmpdir(), 'adk-tools-remover-'));
  mkdirSync(join(dir, 'orgs', 'acme', 'agentes'), { recursive: true });
  writeFileSync(
    join(dir, 'orgs', 'acme', 'org.yaml'),
    ['environments:', `  staging: ${ORG}`].join('\n'),
  );
  writeFileSync(
    join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'),
    [
      'spec_version: v1',
      'kind: agent',
      'slug: ana',
      'definition:',
      '  name: Ana',
      'tools_remover:',
      '  - tool: crm_delete_lead',
      '  - tool: crm_merge_contacts',
      '  - tool: crm_object_delete',
    ].join('\n'),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const env = { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' };
const rodar = (cmd: 'plan' | 'deploy', extra: string[] = []) =>
  runCli(
    [cmd, '--env', 'staging', '--org', ORG, '--dir', dir, ...(cmd === 'deploy' ? ['--yes'] : []), ...extra],
    { env },
  );

const planoBase = { slug: 'ana', changes: [], collaborators: [], blocking: [], pending: [] };

// Duas remoções de verdade e uma já feita (`noop`): o `noop` é o que faz o
// plano convergir e não pode aparecer como mudança.
const PLANO_COM_REMOCOES = {
  ...planoBase,
  action: 'update',
  toolRevocations: [
    { name: 'crm_delete_lead', action: 'remove' },
    { name: 'crm_merge_contacts', action: 'remove' },
    { name: 'crm_object_delete', action: 'noop' },
  ],
};

describe('adk plan — remoção declarada de vínculo (tools_remover)', () => {
  it('mostra uma linha "remover vínculo" por remove e não lista o noop', async () => {
    respostaDoPlano = PLANO_COM_REMOCOES;

    const r = await rodar('plan');

    expect(r.exitCode).toBe(0);
    const linhas = r.stdout.split('\n').filter((l) => l.includes('remover vínculo'));
    expect(linhas.map((l) => l.trim())).toEqual([
      'tool crm_delete_lead: remover vínculo',
      'tool crm_merge_contacts: remover vínculo',
    ]);
    expect(r.stdout).not.toContain('crm_object_delete');
  });

  it('plano convergido (só noop em toolRevocations, action noop) diz "sem alteração"', async () => {
    respostaDoPlano = {
      ...planoBase,
      action: 'noop',
      toolRevocations: [
        { name: 'crm_delete_lead', action: 'noop' },
        { name: 'crm_merge_contacts', action: 'noop' },
        { name: 'crm_object_delete', action: 'noop' },
      ],
    };

    const r = await rodar('plan');

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ana.yaml: sem alteração');
    expect(r.stdout).not.toContain('remover vínculo');
    expect(r.stdout + r.stderr).not.toContain('Hub sem suporte');
  });

  it('--json traz toolRevocations só com os remove na linha do relatório', async () => {
    respostaDoPlano = PLANO_COM_REMOCOES;

    const r = await rodar('plan', ['--json']);

    const relatorio = JSON.parse(r.stdout) as {
      artefatos: { slug: string; toolRevocations: unknown }[];
    };
    const ana = relatorio.artefatos.find((a) => a.slug === 'ana');
    expect(ana?.toolRevocations).toEqual([
      { name: 'crm_delete_lead', action: 'remove' },
      { name: 'crm_merge_contacts', action: 'remove' },
    ]);
  });

  it('--json de plano convergido traz toolRevocations vazio', async () => {
    respostaDoPlano = {
      ...planoBase,
      action: 'noop',
      toolRevocations: [{ name: 'crm_delete_lead', action: 'noop' }],
    };

    const r = await rodar('plan', ['--json']);

    const relatorio = JSON.parse(r.stdout) as {
      artefatos: { slug: string; toolRevocations: unknown }[];
    };
    expect(relatorio.artefatos.find((a) => a.slug === 'ana')?.toolRevocations).toEqual([]);
  });
});

describe('adk plan/deploy — falha fechado com Hub sem suporte a tools_remover', () => {
  // Resposta de um Hub anterior à revogação: plano limpo, sem `toolRevocations`.
  const HUB_ANTIGO = { ...planoBase, action: 'noop' };

  it('plan: Hub não ecoa toolRevocations → "Hub sem suporte a tools_remover", exit != 0', async () => {
    respostaDoPlano = HUB_ANTIGO;

    const r = await rodar('plan');

    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('Hub sem suporte a tools_remover');
  });

  it('deploy: Hub não ecoa toolRevocations → nenhum apply é chamado', async () => {
    respostaDoPlano = HUB_ANTIGO;

    const r = await rodar('deploy');

    expect(chamadas.apply).toBe(0);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain('Hub sem suporte a tools_remover');
  });

  it('deploy: Hub novo com remove → o apply é chamado', async () => {
    respostaDoPlano = PLANO_COM_REMOCOES;

    const r = await rodar('deploy');

    expect(r.exitCode).toBe(0);
    expect(chamadas.apply).toBe(1);
  });
});
