/**
 * issue#2500 — tool `runtime: script` criada por `adk init tool` nunca chegava
 * ao Hub.
 *
 * `adk init tool <slug>` cria uma PASTA `<slug>/` com `manifest.yaml`,
 * `pyproject.toml`, `uv.lock`, `tools/<handler>.py` e `tests/` — e tem de ser
 * pasta, porque a tool de script carrega um pacote Python inteiro. Mas
 * `listarArtefatos` só lia `.yaml` SOLTO em `orgs/<org>/<pasta>/`, então o
 * `adk deploy` não encontrava nada e devolvia "Nenhuma pasta de organização
 * declara <id>" — culpando o `org.yaml`, que estava correto.
 *
 * É a mesma classe do gap que a PR #5 corrigiu para `apps`/`mcp`, agora na
 * dimensão pasta-vs-arquivo.
 *
 * RED antes do fix: os casos de pacote devolvem lista vazia.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listarArtefatos } from '../src/artefatos.js';

const MANIFESTO_SCRIPT = `spec_version: v1
kind: tool
slug: soma-prototipo
definition:
  name: soma_prototipo
  description: Soma dois inteiros e devolve o total, para provar o caminho de script.
  kind: native
  runtime: script
  entry: tools/soma_prototipo.py
  handler: handler
`;

function escreverPacote(raiz: string, org: string, pasta: string, slug: string, manifesto: string) {
  const dir = join(raiz, 'orgs', org, pasta, slug);
  mkdirSync(join(dir, 'tools'), { recursive: true });
  writeFileSync(join(dir, 'manifest.yaml'), manifesto);
  writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "soma"\n');
  writeFileSync(join(dir, 'uv.lock'), 'version = 1\n');
  writeFileSync(join(dir, 'tools', 'soma_prototipo.py'), 'def handler(input):\n    return input\n');
  return dir;
}

function escreverSolto(raiz: string, org: string, pasta: string, arquivo: string, yaml: string) {
  mkdirSync(join(raiz, 'orgs', org, pasta), { recursive: true });
  writeFileSync(join(raiz, 'orgs', org, pasta, arquivo), yaml);
}

describe('listarArtefatos — pacote em subpasta (issue#2500)', () => {
  let raiz: string;

  beforeEach(() => {
    raiz = mkdtempSync(join(tmpdir(), 'adk-artefatos-pacote-'));
  });
  afterEach(() => rmSync(raiz, { recursive: true, force: true }));

  it('encontra a tool de script criada como PASTA com manifest.yaml', () => {
    escreverPacote(raiz, 'acme', 'tools', 'soma-prototipo', MANIFESTO_SCRIPT);

    const achados = listarArtefatos(raiz).filter((a) => a.kind === 'tool');

    expect(achados).toHaveLength(1);
    expect(achados[0].org).toBe('acme');
    expect(achados[0].rota).toBe('tools');
    expect(achados[0].yaml).toContain('runtime: script');
  });

  it('expõe o diretório do pacote — sem ele o deploy não tem o que enviar', () => {
    const dir = escreverPacote(raiz, 'acme', 'tools', 'soma-prototipo', MANIFESTO_SCRIPT);

    const [achado] = listarArtefatos(raiz).filter((a) => a.kind === 'tool');

    expect(achado.dirPacote).toBe(dir);
  });

  it('o .yaml SOLTO continua funcionando (tool sem pacote não regride)', () => {
    escreverSolto(raiz, 'acme', 'tools', 'busca.yaml', 'spec_version: v1\nkind: tool\nslug: busca\n');

    const achados = listarArtefatos(raiz).filter((a) => a.kind === 'tool');

    expect(achados).toHaveLength(1);
    expect(achados[0].arquivo).toBe('busca.yaml');
    // Sem pacote não há diretório de pacote — o deploy não pode inventar um.
    expect(achados[0].dirPacote).toBeUndefined();
  });

  it('os dois formatos convivem na mesma pasta', () => {
    escreverSolto(raiz, 'acme', 'tools', 'busca.yaml', 'spec_version: v1\nkind: tool\nslug: busca\n');
    escreverPacote(raiz, 'acme', 'tools', 'soma-prototipo', MANIFESTO_SCRIPT);

    const achados = listarArtefatos(raiz).filter((a) => a.kind === 'tool');

    expect(achados.map((a) => a.arquivo).sort()).toEqual(
      ['busca.yaml', 'soma-prototipo/manifest.yaml'].sort(),
    );
  });

  it('subpasta SEM manifest.yaml é ignorada (não vira artefato fantasma)', () => {
    mkdirSync(join(raiz, 'orgs', 'acme', 'tools', 'rascunho'), { recursive: true });
    writeFileSync(join(raiz, 'orgs', 'acme', 'tools', 'rascunho', 'notas.md'), '# nada aqui\n');

    expect(listarArtefatos(raiz)).toHaveLength(0);
  });

  it('vale para app também — `adk init app` cria pacote do mesmo jeito', () => {
    const dir = join(raiz, 'orgs', 'acme', 'apps', 'prototipo-adk');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'manifest.yaml'), 'spec_version: v1\nkind: app\nslug: prototipo-adk\n');

    const achados = listarArtefatos(raiz).filter((a) => a.kind === 'app');

    expect(achados).toHaveLength(1);
    expect(achados[0].dirPacote).toBe(dir);
  });
});
