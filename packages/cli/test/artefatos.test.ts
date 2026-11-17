import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promptDe, type Artefato } from '../src/artefatos.js';

// Rodada 3, item 4 (block da review): `prompt_file` apontando para um symlink
// QUEBRADO (o alvo não existe) hoje derruba `promptDe` com uma exceção que
// carrega o caminho ABSOLUTO do host na mensagem — ao contrário do caso de
// symlink que resolve para FORA do repo, que já devolve um `SpecIssue` sem
// abortar. O comportamento esperado é o mesmo dos dois casos: capturado como
// issue do próprio artefato, com um código estável, sem o caminho absoluto.

function artefato(raiz: string, caminho: string, yaml: string): Artefato {
  return {
    pasta: 'agentes',
    kind: 'agent',
    rota: 'agents',
    org: 'acme',
    arquivo: 'ana.yaml',
    caminho,
    raiz,
    yaml,
  };
}

describe('promptDe — symlink quebrado (dangling)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-artefatos-symlink-'));
    mkdirSync(join(dir, 'orgs', 'acme', 'agentes'), { recursive: true });
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('devolve um SpecIssue com código estável em vez de lançar exceção', () => {
    const alvoInexistente = join(dir, 'orgs', 'acme', 'agentes', 'nao-existe.txt');
    symlinkSync(alvoInexistente, join(dir, 'orgs', 'acme', 'agentes', 'prompt.txt'));
    const yaml = ['spec_version: v1', 'kind: agent', 'slug: ana', 'prompt_file: prompt.txt'].join(
      '\n',
    );
    const a = artefato(dir, join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'), yaml);

    expect(() => promptDe(a)).not.toThrow();
    const resultado = promptDe(a);
    expect(resultado.issues.length).toBeGreaterThan(0);
    expect(resultado.issues[0]?.code).toMatch(/^prompt_file_(missing|outside_repo)$/);
  });

  it('alvo que existe mas não é arquivo legível (diretório) vira prompt_file_unreadable, sem lançar nem vazar o caminho do host', () => {
    // O `prompt_file` aponta para um DIRETÓRIO dentro da raiz: realpath resolve,
    // está "dentro", mas `readFileSync` falha (EISDIR).
    mkdirSync(join(dir, 'orgs', 'acme', 'agentes', 'prompt.txt'));
    const yaml = ['spec_version: v1', 'kind: agent', 'slug: ana', 'prompt_file: prompt.txt'].join(
      '\n',
    );
    const a = artefato(dir, join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'), yaml);

    expect(() => promptDe(a)).not.toThrow();
    const resultado = promptDe(a);
    expect(resultado.prompt).toBeUndefined();
    expect(resultado.issues.map((i) => i.code)).toEqual(['prompt_file_unreadable']);
    expect(resultado.issues[0]?.message).not.toContain(dir);
    expect(resultado.issues[0]?.message).toContain('"prompt.txt"');
  });

  it('a mensagem do issue não vaza o caminho absoluto do host', () => {
    const alvoInexistente = join(dir, 'orgs', 'acme', 'agentes', 'nao-existe.txt');
    symlinkSync(alvoInexistente, join(dir, 'orgs', 'acme', 'agentes', 'prompt.txt'));
    const yaml = ['spec_version: v1', 'kind: agent', 'slug: ana', 'prompt_file: prompt.txt'].join(
      '\n',
    );
    const a = artefato(dir, join(dir, 'orgs', 'acme', 'agentes', 'ana.yaml'), yaml);

    const resultado = promptDe(a);
    for (const issue of resultado.issues) {
      expect(issue.message).not.toContain(dir);
      expect(issue.message).not.toContain(tmpdir());
    }
  });
});
