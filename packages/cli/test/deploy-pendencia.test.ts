import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  contagemDoRelatorio,
  linhasDoPlano,
  type LinhaRelatorio,
} from '../src/commands/deploy.js';

// issue#2812 — o rodapé contava `bloqueados` por pendência e `aplicados` por
// `applied`: um artefato aplicado COM pendência caía nos dois (12 + 12 > 13).
// issue#2677 — pendência de referência saía como "✗ bloqueado" e derrubava o
// exit code, embora o apply funcione e a linha vá para AdkPendency.

const HUB = 'http://hub-mock.test';
const ORG = 'org-staging-1';

const PENDENCIA = [{ field: 'channel', slug: 'canal-x', reason: 'not_found' }];

function linha(parcial: Partial<LinhaRelatorio>): LinhaRelatorio {
  return {
    arquivo: 'a.yaml',
    org: 'acme',
    kind: 'agent',
    slug: 'a',
    action: 'update',
    changes: [],
    collaborators: [],
    toolBindings: [],
    toolRevocations: [],
    blocking: [],
    pending: [],
    applied: false,
    ...parcial,
  };
}

describe('contagemDoRelatorio', () => {
  it('aplicado com pendência não é bloqueado: bloqueados + aplicados <= total', () => {
    const r = [
      linha({ pending: PENDENCIA, applied: true }),
      linha({ pending: PENDENCIA, applied: true }),
      linha({ blocking: [{ code: 'x', path: 'p', message: 'm' }] }),
    ];
    const c = contagemDoRelatorio(r);
    expect(c).toEqual({ bloqueados: 1, pendentes: 2, aplicados: 2, aplicadosComPendencia: 2 });
    expect(c.bloqueados + c.aplicados).toBeLessThanOrEqual(r.length);
  });

  it('artefato bloqueado nunca conta como aplicado, mesmo com applied=true', () => {
    const c = contagemDoRelatorio([
      linha({ blocking: [{ code: 'apply_error', path: '', message: 'm' }], applied: true }),
    ]);
    expect(c).toEqual({ bloqueados: 1, pendentes: 0, aplicados: 0, aplicadosComPendencia: 0 });
  });
});

describe('linhasDoPlano', () => {
  it('pendência sai como aviso, não como bloqueado, e não é "resolvida sozinha"', () => {
    const saida = linhasDoPlano('acme/agentes/a.yaml', linha({ pending: PENDENCIA }));
    expect(saida[0]).toBe('  → acme/agentes/a.yaml: atualizar');
    expect(saida[1]).toBe('    ! pendência: não entra no ar até você resolver:');
    // a linha é comum a plan e deploy: não pode afirmar que algo foi gravado
    expect(saida[1]).not.toContain('aplicado');
    expect(saida[2]).toContain('"canal-x" não existe nesta organização');
    expect(saida.join('\n')).not.toContain('bloqueado');
    expect(saida.join('\n')).not.toContain('será resolvida');
  });

  it('pendência junto com desvínculo: a alteração (DESVINCULAR) continua aparecendo', () => {
    const saida = linhasDoPlano(
      'acme/agentes/a.yaml',
      linha({ pending: PENDENCIA, toolBindings: [{ name: 'consulta_pedido', action: 'remove' }] }),
    ).join('\n');
    expect(saida).toContain('pendência');
    expect(saida).toContain('tool consulta_pedido: DESVINCULAR');
  });

  it('pendência num artefato sem alteração também é avisada', () => {
    const saida = linhasDoPlano('x.yaml', linha({ action: 'noop', pending: PENDENCIA }));
    expect(saida[0]).toBe('  = x.yaml: sem alteração');
    expect(saida[1]).toContain('pendência');
  });

  it('bloqueio real continua como "✗ bloqueado"', () => {
    const saida = linhasDoPlano(
      'acme/agentes/a.yaml',
      linha({ blocking: [{ code: 'x', path: 'p', message: 'm' }] }),
    );
    expect(saida).toEqual(['  ✗ acme/agentes/a.yaml: bloqueado', '      p: m']);
  });

  it('bloqueio junto com pendência: os dois são listados', () => {
    const saida = linhasDoPlano(
      'acme/agentes/a.yaml',
      linha({ blocking: [{ code: 'x', path: 'p', message: 'm' }], pending: PENDENCIA }),
    ).join('\n');
    expect(saida).toContain('✗ acme/agentes/a.yaml: bloqueado');
    expect(saida).toContain('p: m');
    expect(saida).toContain('"canal-x" não existe nesta organização');
  });
});

describe('exit code e rodapé de `adk deploy`', () => {
  let respostas: Record<string, unknown>;
  const responder = async ({ request }: { request: Request }) => {
    const { yaml } = (await request.json()) as { yaml: string };
    const slug = /slug: (\S+)/.exec(yaml)![1]!;
    return HttpResponse.json(respostas[slug]);
  };
  const server = setupServer(
    http.post(`${HUB}/api/v1/adk/agents/apply`, responder),
    http.post(`${HUB}/api/v1/adk/agents/plan`, responder),
  );
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  const COM_PENDENCIA = {
    plan: { action: 'update', blocking: [], pending: PENDENCIA },
    applied: true,
  };
  const BLOQUEADO = {
    plan: {
      action: 'create',
      blocking: [{ code: 'unknown_kind', path: 'kind', message: 'kind desconhecido' }],
    },
    applied: false,
  };

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-pendencia-'));
    mkdirSync(join(dir, 'orgs', 'acme', 'agentes'), { recursive: true });
    writeFileSync(
      join(dir, 'orgs', 'acme', 'org.yaml'),
      ['environments:', `  staging: ${ORG}`].join('\n'),
    );
    for (const slug of ['nina', 'ruim']) {
      writeFileSync(
        join(dir, 'orgs', 'acme', 'agentes', `${slug}.yaml`),
        ['spec_version: v1', 'kind: agent', `slug: ${slug}`, 'definition: {}'].join('\n'),
      );
    }
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const rodar = (cmd: 'deploy' | 'plan', ...extra: string[]) =>
    runCli([cmd, '--env', 'staging', '--org', ORG, '--dir', dir, ...extra], {
      env: { ADK_HUB_URL: HUB, ADK_TOKEN: 'fake-token' },
    });

  it('deploy: pendência aplicada não derruba o exit code; rodapé não parece soma', async () => {
    respostas = { nina: COM_PENDENCIA, ruim: COM_PENDENCIA };
    const r = await rodar('deploy');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('2 artefato(s) · 0 bloqueado(s) · 2 aplicado(s) — 2 deles com pendência');
    expect(r.stdout).toContain('adk status');
    expect(r.stdout).not.toContain('✗');
  });

  it('plan: pendência não derruba o exit code', async () => {
    respostas = {
      nina: { ...COM_PENDENCIA, applied: false },
      ruim: { ...COM_PENDENCIA, applied: false },
    };
    const r = await rodar('plan');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('2 artefato(s) · 0 bloqueado(s) · 2 com pendência');
    const linhasPendencia = r.stdout.split('\n').filter((l) => l.includes('! pendência'));
    expect(linhasPendencia.length).toBe(2);
    for (const l of linhasPendencia) expect(l).not.toContain('aplicado');
  });

  it('deploy --json: pendência sai com exit 0 e aparece em pending[]', async () => {
    respostas = { nina: COM_PENDENCIA, ruim: COM_PENDENCIA };
    const r = await rodar('deploy', '--json');
    expect(r.exitCode).toBe(0);
    const rel = JSON.parse(r.stdout);
    expect(rel.artefatos[0].pending).toHaveLength(1);
    expect(rel.artefatos[0].applied).toBe(true);
  });

  // Falha por COMPORTAMENTO sem o conserto: na `main` a pendência entrava em
  // "bloqueado", então esta rodada mista diria 2 bloqueados em vez de 1.
  it('rodada mista: bloqueio real derruba (exit 1) e só ele é contado como bloqueado', async () => {
    respostas = { nina: COM_PENDENCIA, ruim: BLOQUEADO };
    const r = await rodar('deploy');
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('2 artefato(s) · 1 bloqueado(s) · 1 aplicado(s) — 1 deles com pendência');
  });
});
