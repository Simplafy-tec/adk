import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSpecYaml } from '@simpla.fy/adk-contract';
import { comandoBuild } from '../src/commands/build.js';
import { comandoInit } from '../src/commands/init.js';
import type { Ctx } from '../src/ctx.js';
import { usarHubDeProducaoFalso } from './hub-prod-falso.js';

// Sem ADK_HUB_URL, o build consulta a política do Hub de produção: aqui ele é falso.
usarHubDeProducaoFalso();

// issue#2768 — todo esqueleto do `adk init` passava no `adk build` com
// `issues: []` e era RECUSADO pelo servidor por campo que nenhum template cria
// e nenhuma skill menciona. O autor descobria tudo por tentativa e erro contra
// o apply.

function ctxDeTeste(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = {
    cwd,
    env: process.env,
    out: (linha: string) => out.push(linha),
    err: (linha: string) => err.push(linha),
  } as unknown as Ctx;
  return { ctx, out, err };
}

describe('esqueleto do adk init × o que o apply exige', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-init-publicavel-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('`init mcp` gera o manifesto do SATÉLITE, não o de uma tool', () => {
    const { ctx } = ctxDeTeste(dir);
    expect(comandoInit(ctx, 'mcp', 'probe-sat', { dir: join(dir, 'probe-sat') })).toBe(0);
    const yaml = readFileSync(join(dir, 'probe-sat', 'manifest.yaml'), 'utf8');
    const spec = parseSpecYaml(yaml) as Record<string, unknown>;

    // Os três que o servidor cobra, no TOPO — não dentro de `definition`.
    expect(spec.name).toBeDefined();
    expect(String(spec.image)).toMatch(/sha256|TROQUE/);
    expect(String(spec.url)).toMatch(/https?:|TROQUE/);
    expect(spec.definition).toBeUndefined();
    // Só o autor sabe imagem e URL: nascem marcados, não inventados.
    expect(yaml).toContain('TROQUE');
    // E a forma exigida tem de estar dita, não só o campo.
    expect(yaml.toLowerCase()).toContain('digest');
  });

  it('`init app` gera `name` e `icon`, que são colunas do registro', () => {
    const { ctx } = ctxDeTeste(dir);
    expect(comandoInit(ctx, 'app', 'probe-app', { dir: join(dir, 'probe-app') })).toBe(0);
    const spec = parseSpecYaml(
      readFileSync(join(dir, 'probe-app', 'manifest.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(typeof spec.name).toBe('string');
    expect(String(spec.name).length).toBeGreaterThan(0);
    expect(typeof spec.icon).toBe('string');
    expect(String(spec.icon).length).toBeGreaterThan(0);
  });

  it('`init tool` ensina os campos de `runtime: script` que o apply cobra', () => {
    const { ctx } = ctxDeTeste(dir);
    expect(comandoInit(ctx, 'tool', 'probe-tool', { dir: join(dir, 'probe-tool') })).toBe(0);
    const yaml = readFileSync(join(dir, 'probe-tool', 'manifest.yaml'), 'utf8');
    for (const campo of ['runtime: script', 'python:', 'entry:', 'handler:', 'limits:']) {
      expect(yaml).toContain(campo);
    }
  });

  it('o build de um kind julgado no servidor diz que não julgou', async () => {
    const { ctx, out } = ctxDeTeste(dir);
    const raiz = join(dir, 'probe-sat');
    comandoInit(ctx, 'mcp', 'probe-sat', { dir: raiz });
    out.length = 0;
    await comandoBuild(ctx, { dir: raiz });
    const saida = JSON.parse(out.join('\n')) as {
      contrato?: { parcial?: boolean; campos_obrigatorios?: { campo: string }[] };
    };
    expect(saida.contrato?.parcial).toBe(true);
    expect(saida.contrato?.campos_obrigatorios?.map((c) => c.campo)).toContain('image');
  }, 60_000);

  it('o build de `tool` (julgada localmente) não ganha o rótulo de parcial', async () => {
    const { ctx, out } = ctxDeTeste(dir);
    const raiz = join(dir, 'probe-tool');
    comandoInit(ctx, 'tool', 'probe-tool', { dir: raiz });
    out.length = 0;
    await comandoBuild(ctx, { dir: raiz });
    const saida = JSON.parse(out.join('\n')) as { contrato?: unknown };
    expect(saida.contrato).toBeUndefined();
  }, 60_000);
});
