import { describe, expect, it } from 'vitest';
import { parseSpecYaml, serializeSpecYaml } from '../src/index.js';

// Generalização de agent-yaml.ts (agent-only) para os 3 kinds — mesma KEY_ORDER.

describe('serializeSpecYaml / parseSpecYaml', () => {
  it('mantém a KEY_ORDER estável (spec_version, kind, slug, ... antes de campos desconhecidos)', () => {
    const spec = {
      collaborators: [],
      slug: 'ana',
      kind: 'agent' as const,
      spec_version: 'v1',
      definition: {},
    };
    const yaml = serializeSpecYaml(spec);
    const ordemEncontrada = ['spec_version', 'kind', 'slug', 'definition', 'collaborators'].map(
      (chave) => yaml.indexOf(`${chave}:`),
    );
    const ordenado = [...ordemEncontrada].sort((a, b) => a - b);
    expect(ordemEncontrada).toEqual(ordenado);
  });

  it('round-trip: parse(serialize(spec)) preserva os campos', () => {
    const spec = {
      kind: 'tool' as const,
      spec_version: 'v1',
      slug: 'minha-tool',
      definition: { name: 'minha_tool', description: 'x'.repeat(25), kind: 'native' },
    };
    const yaml = serializeSpecYaml(spec);
    expect(parseSpecYaml(yaml)).toMatchObject(spec);
  });

  it('parseSpecYaml de documento vazio devolve objeto vazio (não lança)', () => {
    expect(parseSpecYaml('')).toEqual({});
  });
});
