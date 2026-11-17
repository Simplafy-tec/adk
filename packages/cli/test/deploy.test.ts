import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';

// Hub mockado com as rotas reais POST /api/v1/adk/{tools|agents|journeys}/{plan|apply}
// citadas no brief. `adk deploy` = apply de todos os artefatos da pasta da org.

const HUB = 'http://hub-mock.test';
const ORG = 'org-staging-1';

const applied: string[] = [];

const server = setupServer(
  http.post(`${HUB}/api/v1/adk/tools/apply`, async ({ request }) => {
    const url = new URL(request.url);
    const orgId = url.searchParams.get('orgId');
    const body = (await request.json()) as { yaml: string };
    applied.push('tools');
    if (body.yaml.includes('kind: tool_invalida_de_propósito')) {
      return HttpResponse.json({
        plan: { action: 'create', blocking: [{ code: 'unknown_kind', path: 'kind', message: 'kind desconhecido' }] },
        applied: false,
      });
    }
    return HttpResponse.json({ plan: { action: 'create', blocking: [] }, applied: true, orgId });
  }),
  http.post(`${HUB}/api/v1/adk/agents/apply`, async () => {
    applied.push('agents');
    return HttpResponse.json({ plan: { action: 'noop', blocking: [] }, applied: true });
  }),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  applied.length = 0;
});
afterAll(() => server.close());

function orgFixture(dir: string) {
  mkdirSync(join(dir, 'orgs', 'acme', 'tools'), { recursive: true });
  mkdirSync(join(dir, 'orgs', 'acme', 'agentes'), { recursive: true });
  writeFileSync(
    join(dir, 'orgs', 'acme', 'org.yaml'),
    // comentário e indentação variada — deve ser parseado com `yaml`, não regex
    ['# organização Acme', 'environments:', `  staging: ${ORG}`, '  prod: org-prod-1'].join('\n'),
  );
  writeFileSync(
    join(dir, 'orgs', 'acme', 'tools', 'tool-boa.yaml'),
    ['spec_version: v1', 'kind: tool', 'slug: tool-boa', 'definition:', '  name: tool_boa'].join('\n'),
  );
  writeFileSync(
    join(dir, 'orgs', 'acme', 'tools', 'tool-ruim.yaml'),
    ['spec_version: v1', 'kind: tool_invalida_de_propósito', 'slug: tool-ruim'].join('\n'),
  );
  writeFileSync(
    join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'),
    ['spec_version: v1', 'kind: agent', 'slug: ana', 'definition: {}'].join('\n'),
  );
}

describe('adk deploy --env staging --org <id>', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-deploy-'));
    orgFixture(dir);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('aplica os artefatos válidos e reporta bloqueio no inválido sem abortar os demais', async () => {
    const result = await runCli(['deploy', '--env', 'staging', '--org', ORG, '--dir', dir], {
      env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' },
    });
    // 3 artefatos: tool-boa (aplica), tool-ruim (bloqueia), ana (aplica) — 1 erro não aborta os demais.
    expect(result.exitCode).toBe(1);
    expect(applied).toContain('tools');
    expect(applied).toContain('agents');
  });

  it('--json emite um relatório com os 3 artefatos, inclusive o bloqueado', async () => {
    const result = await runCli(
      ['deploy', '--env', 'staging', '--org', ORG, '--dir', dir, '--json'],
      { env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' } },
    );
    const relatorio = JSON.parse(result.stdout);
    expect(relatorio.artefatos).toHaveLength(3);
    const ruim = relatorio.artefatos.find((a: { arquivo: string }) => a.arquivo === 'tool-ruim.yaml');
    expect(ruim.blocking).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'unknown_kind' })]),
    );
  });

  it('ordem de aplicação é tool → agent → journey', async () => {
    await runCli(['deploy', '--env', 'staging', '--org', ORG, '--dir', dir], {
      env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' },
    });
    expect(applied.indexOf('tools')).toBeLessThan(applied.indexOf('agents'));
  });
});

describe('eco do plano e rodapé do apply', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-eco-'));
    mkdirSync(join(dir, 'orgs', 'acme', 'agentes'), { recursive: true });
    writeFileSync(
      join(dir, 'orgs', 'acme', 'org.yaml'),
      ['environments:', `  staging: ${ORG}`].join('\n'),
    );
    writeFileSync(
      join(dir, 'orgs', 'acme', 'agentes', 'nina.yaml'),
      [
        'spec_version: v1',
        'kind: agent',
        'slug: nina',
        'definition:',
        '  name: Nina',
        '  temperature: 0.2',
      ].join('\n'),
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const planoVazio = { slug: 'nina', changes: [], collaborators: [], blocking: [], pending: [] };

  /** O Hub responde ao plan e ao apply com o mesmo plano; `applied` é o do apply. */
  function hubResponde(plan: Record<string, unknown>, applied: boolean) {
    server.use(
      http.post(`${HUB}/api/v1/adk/agents/plan`, () => HttpResponse.json({ plan, applied: false })),
      http.post(`${HUB}/api/v1/adk/agents/apply`, () => HttpResponse.json({ plan, applied })),
    );
  }

  const rodar = (cmd: 'plan' | 'deploy') =>
    runCli([cmd, '--env', 'staging', '--org', ORG, '--dir', dir], {
      env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' },
    });

  it('agente novo mostra só o valor de cada campo, sem "undefined →"', async () => {
    // Na criação o Hub não tem "antes": a mudança chega sem `from` no JSON.
    hubResponde(
      {
        ...planoVazio,
        action: 'create',
        changes: [
          { field: 'name', to: 'Nina' },
          { field: 'temperature', to: 0.2 },
        ],
      },
      false,
    );

    const r = await rodar('plan');

    expect(r.exitCode).toBe(0);
    const linhas = r.stdout.split('\n');
    expect(linhas).toContain('  → acme/agentes/nina.yaml: criar');
    expect(linhas).toContain('      name: "Nina"');
    expect(linhas).toContain('      temperature: 0.2');
    expect(r.stdout).not.toContain('undefined');
  });

  it('agente existente continua mostrando o de→para do campo', async () => {
    hubResponde(
      { ...planoVazio, action: 'update', changes: [{ field: 'name', from: 'Nina', to: 'Nina 2' }] },
      false,
    );

    const r = await rodar('plan');

    expect(r.stdout.split('\n')).toContain('      name: "Nina" → "Nina 2"');
  });

  it('apply com plano noop e applied=true do Hub conta como aplicado (prompt gravado)', async () => {
    // O plano do agente não compara o prompt: um apply que só muda o prompt
    // chega `noop`, sem vínculo, e o Hub grava o systemPrompt (`applied: true`).
    // O rodapé segue o `applied` do Hub para não esconder essa escrita.
    hubResponde({ ...planoVazio, action: 'noop' }, true);

    const r = await rodar('deploy');

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('1 artefato(s) · 0 bloqueado(s) · 1 aplicado(s)');
  });

  it('apply de agente noop que DESVINCULA tool conta como aplicado', async () => {
    // No Hub real um vínculo `remove` vira plano `update`; o `noop` aqui é
    // defesa da CLI, não o contrato atual do Hub.
    hubResponde(
      { ...planoVazio, action: 'noop', toolBindings: [{ name: 'consulta_pedido', action: 'remove' }] },
      true,
    );

    const r = await rodar('deploy');

    expect(r.stdout).toContain('tool consulta_pedido: DESVINCULAR');
    expect(r.stdout).toContain('1 artefato(s) · 0 bloqueado(s) · 1 aplicado(s)');
  });
});
