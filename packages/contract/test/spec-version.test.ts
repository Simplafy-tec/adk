import { describe, expect, it } from 'vitest';
import { SPEC_VERSION, SUPPORTED_SPEC_VERSIONS, validateSpecStructureAs } from '../src/index.js';

describe('SPEC_VERSION', () => {
  it('é v1 nesta rodada (N-1 só existirá quando v2 nascer)', () => {
    expect(SPEC_VERSION).toBe('v1');
    expect(SUPPORTED_SPEC_VERSIONS).toEqual(['v1']);
  });

  it('aceita spec_version v1', () => {
    const issues = validateSpecStructureAs('tool', {
      kind: 'tool',
      spec_version: 'v1',
      slug: 'minha-tool',
      definition: {
        name: 'minha_tool',
        description: 'Descrição com mais de vinte caracteres para passar no portão.',
        kind: 'native',
        input_schema: { type: 'object', properties: {} },
      },
    });
    expect(issues.find((i) => i.code === 'unknown_spec_version')).toBeUndefined();
  });

  it('recusa spec_version v2 com unknown_spec_version', () => {
    const issues = validateSpecStructureAs('tool', {
      kind: 'tool',
      spec_version: 'v2',
      slug: 'minha-tool',
      definition: {
        name: 'minha_tool',
        description: 'Descrição com mais de vinte caracteres para passar no portão.',
        kind: 'native',
        input_schema: { type: 'object', properties: {} },
      },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'unknown_spec_version', path: 'spec_version' }),
    );
  });
});
