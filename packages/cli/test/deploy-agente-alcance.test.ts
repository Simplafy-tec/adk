import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// Hub#2.6.21.83 (review) — o `adk plan`/`deploy` mostra o de→para das áreas do
// Agent Control e do Alcance do vínculo, e FALHA FECHADO quando o arquivo
// declara `agent_control`, `alcance` ou `crmAlcance` e o Hub não ecoa esses
// campos no plano: um Hub antigo ignoraria o bloco e diria "aplicado".
//
// Contrato do eco (o que o Hub novo devolve no plano do agente):
// - `agentControl: {action, from?, to}` sempre que o arquivo declara `agent_control`;
// - `toolBindings[i].alcance: {from, to}` em todo vínculo que declara `alcance`;
// - `crmAlcance: {from, to}` sempre que o arquivo declara `definition.crmAlcance`.

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
  dir = mkdtempSync(join(tmpdir(), 'adk-alcance-'));
  mkdirSync(join(dir, 'orgs', 'acme', 'agentes'), { recursive: true });
  writeFileSync(
    join(dir, 'orgs', 'acme', 'org.yaml'),
    ['environments:', `  staging: ${ORG}`].join('\n'),
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function agente(linhas: string[]) {
  writeFileSync(
    join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'),
    ['spec_version: v1', 'kind: agent', 'slug: ana', 'definition:', '  name: Ana', ...linhas].join(
      '\n',
    ),
  );
}

const rodar = (cmd: 'plan' | 'deploy') =>
  runCli([cmd, '--env', 'staging', '--org', ORG, '--dir', dir, '--yes'].filter((a) => cmd === 'deploy' || a !== '--yes'), {
    env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' },
  });

const COM_AGENT_CONTROL = ['agent_control:', '  areas:', '    crm: write'];
const COM_ALCANCE = ['tools:', '  - tool: app_avaliacoes', '    alcance: OPERADOR'];
const COM_CRM_ALCANCE = ['  crmAlcance: OPERADOR'];

const planoBase = { slug: 'ana', changes: [], collaborators: [], blocking: [], pending: [] };

describe('adk plan — de→para das áreas do Agent Control e do Alcance', () => {
  it('mostra agent_control.areas: {de} → {para}', async () => {
    agente(COM_AGENT_CONTROL);
    respostaDoPlano = {
      ...planoBase,
      action: 'update',
      agentControl: { action: 'update', from: { crm: 'read' }, to: { crm: 'write' } },
    };

    const r = await rodar('plan');

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('agent_control.areas: {"crm":"read"} → {"crm":"write"}');
  });

  it('agent_control criado agora mostra {} → {para}', async () => {
    agente(COM_AGENT_CONTROL);
    respostaDoPlano = {
      ...planoBase,
      action: 'update',
      agentControl: { action: 'create', to: { crm: 'write' } },
    };

    const r = await rodar('plan');

    expect(r.stdout).toContain('agent_control.areas: {} → {"crm":"write"}');
  });

  // Áreas `none` não entram no `to` do Hub: um agente novo que só desliga
  // áreas recebe `{action: 'create', to: {}}` — nada a ecoar.
  const SO_AREAS_NONE = ['agent_control:', '  areas:', '    crm: none', '    agenda: none'];
  const AGENTE_NOVO_SO_NONE = {
    ...planoBase,
    action: 'create',
    changes: [{ field: 'name', to: 'Ana' }],
    agentControl: { action: 'create', to: {} },
  };

  it('agente novo com só áreas none não imprime agent_control.areas no plan', async () => {
    agente(SO_AREAS_NONE);
    respostaDoPlano = AGENTE_NOVO_SO_NONE;

    const r = await rodar('plan');

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ana.yaml: criar');
    expect(r.stdout).not.toContain('agent_control.areas');
    expect(r.stdout).not.toContain('Hub sem suporte');
  });

  it('agente novo com só áreas none: o deploy aplica e não imprime agent_control.areas', async () => {
    agente(SO_AREAS_NONE);
    respostaDoPlano = AGENTE_NOVO_SO_NONE;

    const r = await rodar('deploy');

    expect(r.exitCode).toBe(0);
    expect(chamadas.apply).toBe(1);
    expect(r.stdout).not.toContain('agent_control.areas');
  });

  it('desligar todas as áreas gravadas continua ecoando {de} → {}', async () => {
    agente(SO_AREAS_NONE);
    respostaDoPlano = {
      ...planoBase,
      action: 'update',
      agentControl: { action: 'update', from: { crm: 'read' }, to: {} },
    };

    const r = await rodar('plan');

    expect(r.stdout).toContain('agent_control.areas: {"crm":"read"} → {}');
  });

  it('agente existente sem a linha do Agent Control continua ecoando {} → {} com só áreas none', async () => {
    // Sem `from`, o agente existente não tem a linha do Agent Control: o apply
    // a cria (liga o Agent Control neste agente). Há escrita, então há eco.
    agente(SO_AREAS_NONE);
    respostaDoPlano = {
      ...planoBase,
      action: 'update',
      agentControl: { action: 'create', to: {} },
    };

    const r = await rodar('plan');

    expect(r.stdout).toContain('agent_control.areas: {} → {}');
  });

  it('mostra o de→para do alcance no update do vínculo', async () => {
    agente(COM_ALCANCE);
    respostaDoPlano = {
      ...planoBase,
      action: 'update',
      toolBindings: [
        {
          name: 'app_avaliacoes',
          action: 'update',
          changes: [{ field: 'config', from: {}, to: { alcance: 'OPERADOR' } }],
          alcance: { from: 'SO_QUEM_FALA', to: 'OPERADOR' },
        },
      ],
    };

    const r = await rodar('plan');

    expect(r.exitCode).toBe(0);
    const linhaDaTool = r.stdout.split('\n').find((l) => l.includes('tool app_avaliacoes'));
    expect(linhaDaTool).toContain('alcance SO_QUEM_FALA → OPERADOR');
  });

  it('Hub novo convergido (eco presente, noop) segue "sem alteração" e exit 0', async () => {
    agente([...COM_CRM_ALCANCE, ...COM_ALCANCE, ...COM_AGENT_CONTROL]);
    respostaDoPlano = {
      ...planoBase,
      action: 'noop',
      agentControl: { action: 'noop', from: { crm: 'write' }, to: { crm: 'write' } },
      crmAlcance: { from: 'OPERADOR', to: 'OPERADOR' },
      toolBindings: [
        { name: 'app_avaliacoes', action: 'noop', alcance: { from: 'OPERADOR', to: 'OPERADOR' } },
      ],
    };

    const r = await rodar('plan');

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('sem alteração');
    expect(r.stdout + r.stderr).not.toContain('Hub sem suporte');
  });
});

describe('adk plan/deploy — falha fechado com Hub sem suporte aos campos novos', () => {
  // Resposta de um Hub ANTERIOR à Hub#2.6.21.83: plano limpo, sem eco nenhum.
  const HUB_ANTIGO = { ...planoBase, action: 'noop', toolBindings: [{ name: 'app_avaliacoes', action: 'noop' }] };

  it.each([
    ['agent_control', COM_AGENT_CONTROL],
    ['alcance', COM_ALCANCE],
    ['crmAlcance', COM_CRM_ALCANCE],
  ] as const)('plan: arquivo declara %s e o Hub não ecoa → "Hub sem suporte a …", exit != 0', async (campo, linhas) => {
    agente([...linhas]);
    respostaDoPlano = HUB_ANTIGO;

    const r = await rodar('plan');

    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(`Hub sem suporte a ${campo}`);
  });

  it.each([
    ['agent_control', COM_AGENT_CONTROL],
    ['alcance', COM_ALCANCE],
    ['crmAlcance', COM_CRM_ALCANCE],
  ] as const)('deploy: arquivo declara %s e o Hub não ecoa → nenhum apply é chamado, exit != 0', async (campo, linhas) => {
    agente([...linhas]);
    respostaDoPlano = HUB_ANTIGO;

    const r = await rodar('deploy');

    expect(chamadas.apply).toBe(0);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(`Hub sem suporte a ${campo}`);
  });

  it('arquivo SEM os campos novos e Hub antigo: deploy segue normal (sem falso positivo)', async () => {
    agente([]);
    respostaDoPlano = { ...planoBase, action: 'noop' };

    const r = await rodar('deploy');

    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).not.toContain('Hub sem suporte');
  });
});
