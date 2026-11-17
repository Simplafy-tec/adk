/**
 * issue#2500 parte 2 — o `deploy` precisa ENVIAR o pacote da tool
 * `runtime: script`.
 *
 * O servidor já aceita (`POST /adk/tools/apply` recebe `{yaml, sourceRef,
 * bundle}`) e EXIGE artefato para `runtime: script`: sem `{entry, handler}` +
 * pacote o `RunToolJobDataSchema` do tools-worker não tem o que executar. Mas a
 * CLI nunca montou o `bundle` — `pacote.ts` só varria o diretório para o
 * `build` validar. Resultado medido em staging: zero tools com `entry`/`handler`
 * no banco, com gateway e worker no ar.
 *
 * O hash é conferido de novo pelo servidor (`bundleHashOf`), então a
 * canonicalização daqui tem de ser a MESMA — chaves ordenadas
 * recursivamente. Hash divergente = apply recusado.
 *
 * RED antes do fix: `montarBundle` não existe.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { caminhoDoPacote, montarBundle } from '../src/bundle.js';

/** Espelho do `canonicalJson` do Hub (apps/api/src/common/canonical-json.ts). */
function canonico(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonico).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonico(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function pacote(raiz: string) {
  mkdirSync(join(raiz, 'tools'), { recursive: true });
  mkdirSync(join(raiz, 'tests'), { recursive: true });
  writeFileSync(join(raiz, 'manifest.yaml'), 'kind: tool\n');
  writeFileSync(join(raiz, 'pyproject.toml'), '[project]\nname = "soma"\n');
  writeFileSync(join(raiz, 'uv.lock'), 'version = 1\nrequires-python = ">=3.12"\n');
  writeFileSync(join(raiz, 'tools', 'soma.py'), 'def handler(i):\n    return i\n');
  writeFileSync(join(raiz, 'tests', 'test_soma.py'), 'def test_ok():\n    assert True\n');
}

describe('montarBundle — pacote da tool de script (issue#2500)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'adk-bundle-'));
    pacote(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('inclui o código do handler, com caminho relativo', () => {
    const b = montarBundle(dir);

    expect(b.files['tools/soma.py']).toContain('def handler');
  });

  it('leva o uv.lock em campo próprio, não dentro de files', () => {
    const b = montarBundle(dir);

    expect(b.lock).toContain('requires-python');
    expect(b.files['uv.lock']).toBeUndefined();
  });

  it('o hash bate com a canonicalização do servidor', () => {
    const b = montarBundle(dir);

    const esperado = createHash('sha256')
      .update(canonico({ files: b.files, lock: b.lock }))
      .digest('hex');
    expect(b.hash).toBe(esperado);
  });

  it('o hash NÃO muda quando só a ordem de leitura mudaria', () => {
    const a = montarBundle(dir);
    // Dentro de `tools/` de propósito: fora do allowlist o arquivo é filtrado e
    // o hash não mudaria — o teste passaria pelo motivo errado.
    writeFileSync(join(dir, 'tools', 'aaa-primeiro.py'), 'x = 1\n');
    const b = montarBundle(dir);

    // conteúdo novo muda o hash (senão o teste acima seria vácuo)...
    expect(b.hash).not.toBe(a.hash);
    // ...mas montar duas vezes o MESMO diretório dá o mesmo hash.
    expect(montarBundle(dir).hash).toBe(b.hash);
  });

  it('ignora o que não é fonte do pacote (.venv, __pycache__)', () => {
    mkdirSync(join(dir, '.venv'), { recursive: true });
    writeFileSync(join(dir, '.venv', 'lixo.py'), 'segredo = 1\n');
    mkdirSync(join(dir, '__pycache__'), { recursive: true });
    writeFileSync(join(dir, '__pycache__', 'x.pyc'), 'bin\n');

    const b = montarBundle(dir);

    expect(Object.keys(b.files).some((f) => f.includes('.venv'))).toBe(false);
    expect(Object.keys(b.files).some((f) => f.includes('__pycache__'))).toBe(false);
  });

  it('pacote sem uv.lock é recusado — o worker não teria como hidratar o ambiente', () => {
    rmSync(join(dir, 'uv.lock'));

    expect(() => montarBundle(dir)).toThrow(/uv\.lock/);
  });
});

describe('caminhoDoPacote — allowlist espelhado do servidor (issue#2500)', () => {
  it('aceita o que o servidor aceita', () => {
    for (const ok of [
      'tools/soma.py',
      'tests/test_soma.py',
      'dev/sample-input.json',
      'pyproject.toml',
      'uv.lock',
      'manifest.yaml',
      'README.md',
      '.python-version',
      '.gitignore',
    ]) {
      expect(caminhoDoPacote(ok), ok).toBe(true);
    }
  });

  it('recusa o resto — `.pytest_cache/` e o caso real que reprovou em staging', () => {
    for (const nao of ['.pytest_cache/README.md', 'segredos.env', 'docs/interno.md', 'x.py']) {
      expect(caminhoDoPacote(nao), nao).toBe(false);
    }
  });

  it('o bundle montado não carrega o que o servidor recusaria', () => {
    const dir = mkdtempSync(join(tmpdir(), 'adk-bundle-cache-'));
    pacote(dir);
    mkdirSync(join(dir, '.pytest_cache'), { recursive: true });
    writeFileSync(join(dir, '.pytest_cache', 'README.md'), '# cache\n');

    const b = montarBundle(dir);

    expect(Object.keys(b.files).some((f) => f.startsWith('.pytest_cache'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
