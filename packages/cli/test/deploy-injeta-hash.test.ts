/**
 * issue#2500 parte 3 — o spec enviado tem de declarar `hash` e `lock`.
 *
 * O Hub confere `validateBundle(bundle, spec.definition.hash)`: o pacote vai no
 * corpo, mas o HASH é declarado no spec, e os dois têm de bater. Sem isso o
 * apply recusa com "Hash do pacote inválido: undefined" e "Falta o conteúdo do
 * uv.lock" — medido contra staging em 2026-09-01.
 *
 * Fazer o autor colar o `uv.lock` inteiro dentro do manifest.yaml na mão seria
 * convite a divergência: o lock muda a cada `uv lock` e o hash a cada linha de
 * código. Quem sabe o conteúdo real é o pacote no disco, então é o `deploy` que
 * injeta — no YAML que vai pelo fio, nunca no arquivo do autor.
 *
 * RED: `injetarPacoteNoSpec` não existe.
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { injetarPacoteNoSpec } from '../src/bundle.js';

const YAML_SCRIPT = `spec_version: v1
kind: tool
slug: soma-prototipo
definition:
  name: soma_prototipo
  description: Soma dois inteiros e devolve o total, para provar o caminho.
  kind: native
  runtime: script
  entry: tools/soma_prototipo.py
  handler: handler
`;

const BUNDLE = {
  files: { 'tools/soma_prototipo.py': 'def handler(i):\n    return i\n' },
  lock: 'version = 1\nrequires-python = ">=3.12"\n',
  hash: 'b'.repeat(64),
};

describe('injetarPacoteNoSpec (issue#2500)', () => {
  it('declara hash e lock em definition, a partir do pacote real', () => {
    const doc = parse(injetarPacoteNoSpec(YAML_SCRIPT, BUNDLE)) as {
      definition: { hash: string; lock: string };
    };

    expect(doc.definition.hash).toBe(BUNDLE.hash);
    expect(doc.definition.lock).toBe(BUNDLE.lock);
  });

  it('preserva o resto do spec — injetar não pode reescrever a tool', () => {
    const doc = parse(injetarPacoteNoSpec(YAML_SCRIPT, BUNDLE)) as {
      slug: string;
      definition: Record<string, unknown>;
    };

    expect(doc.slug).toBe('soma-prototipo');
    expect(doc.definition.entry).toBe('tools/soma_prototipo.py');
    expect(doc.definition.handler).toBe('handler');
    expect(doc.definition.runtime).toBe('script');
  });

  it('o hash declarado pelo autor é SOBRESCRITO pelo do pacote real', () => {
    // Um hash velho no arquivo (de antes da última edição do código) não pode
    // vencer o conteúdo do disco — senão o apply subiria código novo com hash
    // antigo, e o servidor recusaria por divergência sem dizer o porquê.
    const comHashVelho = YAML_SCRIPT + '  hash: ' + 'a'.repeat(64) + '\n';

    const doc = parse(injetarPacoteNoSpec(comHashVelho, BUNDLE)) as {
      definition: { hash: string };
    };

    expect(doc.definition.hash).toBe(BUNDLE.hash);
  });
});
