/**
 * hub#2.6.21.19 (N10) — AC "CLI percorre mcp/ e apps/".
 *
 * O servidor já aceita `kind: mcp` e `kind: app` (rotas `/adk/mcp/*` e
 * `/adk/apps/*` em staging), e `adk init app` cria o esqueleto. Mas
 * `listarArtefatos` só varria `tools/`, `agentes/` e `jornadas/`, então o
 * `adk deploy` NUNCA encontrava um app ou um servidor MCP satélite — o
 * protótipo fim a fim ("deploy do app para duas orgs de exemplo sem build do Hub")
 * não era executável.
 *
 * RED: antes do fix, os dois primeiros casos devolvem lista vazia.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listarArtefatos, PASTAS } from '../src/artefatos.js';

function escrever(raiz: string, org: string, pasta: string, arquivo: string, yaml: string) {
  mkdirSync(join(raiz, 'orgs', org, pasta), { recursive: true });
  writeFileSync(join(raiz, 'orgs', org, pasta, arquivo), yaml);
}

describe('listarArtefatos — apps/ e mcp/ (N10)', () => {
  let raiz: string;

  beforeEach(() => {
    raiz = mkdtempSync(join(tmpdir(), 'adk-artefatos-apps-'));
  });
  afterEach(() => rmSync(raiz, { recursive: true, force: true }));

  it('encontra um app declarado em orgs/<org>/apps/', () => {
    escrever(raiz, 'acme', 'apps', 'prototipo-adk.yaml', 'spec_version: v1\nkind: app\nslug: prototipo-adk\n');

    const achados = listarArtefatos(raiz).filter((a) => a.kind === 'app');

    expect(achados).toHaveLength(1);
    expect(achados[0].org).toBe('acme');
    expect(achados[0].arquivo).toBe('prototipo-adk.yaml');
    // A rota é o segmento da API do Hub — sem ela o deploy não sabe para onde POSTar.
    expect(achados[0].rota).toBe('apps');
  });

  it('encontra um servidor MCP satélite declarado em orgs/<org>/mcp/', () => {
    escrever(raiz, 'beta', 'mcp', 'satelite.yaml', 'spec_version: v1\nkind: mcp\nslug: satelite\n');

    const achados = listarArtefatos(raiz).filter((a) => a.kind === 'mcp');

    expect(achados).toHaveLength(1);
    expect(achados[0].org).toBe('beta');
    expect(achados[0].rota).toBe('mcp');
  });

  it('não regride as três pastas que já funcionavam', () => {
    escrever(raiz, 'acme', 'tools', 't.yaml', 'spec_version: v1\nkind: tool\nslug: t\n');
    escrever(raiz, 'acme', 'agentes', 'a.yaml', 'spec_version: v1\nkind: agent\nslug: a\n');
    escrever(raiz, 'acme', 'jornadas', 'j.yaml', 'spec_version: v1\nkind: journey\nslug: j\n');

    const kinds = listarArtefatos(raiz).map((a) => a.kind).sort();

    expect(kinds).toEqual(['agent', 'journey', 'tool']);
  });

  it('a ordem de PASTAS respeita a dependência: tool e mcp antes de agent, agent antes de journey', () => {
    const ordem = PASTAS.map((p) => p.kind);
    // O agente REFERENCIA tool e servidor MCP; a jornada referencia o agente.
    // Aplicar fora desta ordem produz pendência de referência (N2) evitável.
    expect(ordem.indexOf('tool')).toBeLessThan(ordem.indexOf('agent'));
    expect(ordem.indexOf('mcp')).toBeLessThan(ordem.indexOf('agent'));
    expect(ordem.indexOf('agent')).toBeLessThan(ordem.indexOf('journey'));
  });
});
