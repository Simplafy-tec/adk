import { describe, expect, it } from 'vitest';
import { linhasDoPlano } from '../src/commands/deploy.js';

// Hub#2.6.26.3 — o apply de um satélite sem `url:` devolve a URL que a plataforma derivou; a CLI a imprime.
const base = {
  arquivo: 'satelite-x.yaml',
  org: 'acme',
  kind: 'mcp',
  slug: 'satelite-x',
  action: 'create',
  changes: [{ field: 'url', to: 'https://satellites.exemplo.com.br/s/acme/mcp' }],
  collaborators: [],
  toolBindings: [],
  toolRevocations: [],
  blocking: [],
  pending: [],
};

describe('adk apply imprime a URL do satélite', () => {
  it('apply gravou: a URL resolvida sai ao fim do artefato', () => {
    const linhas = linhasDoPlano('acme/mcp/satelite-x.yaml', {
      ...base,
      applied: true,
      satelliteUrl: 'https://satellites.exemplo.com.br/s/acme/mcp',
    });
    expect(linhas[linhas.length - 1]).toBe('      URL do satélite: https://satellites.exemplo.com.br/s/acme/mcp');
  });

  it('reaplicar (noop) também diz onde o satélite está', () => {
    const linhas = linhasDoPlano('acme/mcp/satelite-x.yaml', {
      ...base,
      action: 'noop',
      changes: [],
      applied: false,
      satelliteUrl: 'https://satellites.exemplo.com.br/s/acme/mcp',
    });
    expect(linhas.join('\n')).toContain('sem alteração');
  });

  it('só plano (não aplicou): não imprime URL, que ainda não existe', () => {
    const linhas = linhasDoPlano('acme/mcp/satelite-x.yaml', {
      ...base,
      applied: false,
      satelliteUrl: 'https://satellites.exemplo.com.br/s/acme/mcp',
    });
    expect(linhas.join('\n')).not.toContain('URL do satélite');
  });

  it('sem URL na resposta (outro kind): saída igual à de antes', () => {
    const linhas = linhasDoPlano('acme/agentes/ana.yaml', { ...base, kind: 'agent', applied: true });
    expect(linhas.join('\n')).not.toContain('URL do satélite');
  });
});
