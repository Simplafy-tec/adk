import { describe, expect, it } from 'vitest';
import { camposComEcoDeclarados, camposSemEco } from '../src/eco-do-plano.js';
import type { Plano } from '../src/hub.js';

// Um Hub anterior à revogação declarada ignora `tools_remover` (o Portão 1 não
// recusa chave de topo desconhecida) e responde "sem alteração": o vínculo
// órfão continuaria concedendo a tool com o plano dizendo que está tudo certo.
// O eco é `toolRevocations` no plano, presente sempre que o arquivo declara
// `tools_remover`, inclusive convergido.

const AGENTE_COM_REMOCAO = [
  'spec_version: v1',
  'kind: agent',
  'slug: ana',
  'definition:',
  '  name: Ana',
  'tools_remover:',
  '  - tool: crm_delete_lead',
  '  - integration: Pipefy',
].join('\n');

const AGENTE_SEM_REMOCAO = [
  'spec_version: v1',
  'kind: agent',
  'slug: ana',
  'definition:',
  '  name: Ana',
].join('\n');

const planoLimpo: Plano = { slug: 'ana', action: 'noop', changes: [], blocking: [], pending: [] };

describe('camposComEcoDeclarados — tools_remover', () => {
  it('lista tools_remover quando o arquivo declara a chave', () => {
    expect(camposComEcoDeclarados(AGENTE_COM_REMOCAO)).toContain('tools_remover');
  });

  it('não lista tools_remover quando o arquivo não declara a chave', () => {
    expect(camposComEcoDeclarados(AGENTE_SEM_REMOCAO)).not.toContain('tools_remover');
  });
});

describe('camposSemEco — tools_remover', () => {
  it('plano sem toolRevocations (Hub antigo) acusa tools_remover sem eco', () => {
    expect(camposSemEco(AGENTE_COM_REMOCAO, planoLimpo)).toContain('tools_remover');
  });

  it('toolRevocations vazio já é eco: o Hub entende o campo', () => {
    expect(camposSemEco(AGENTE_COM_REMOCAO, { ...planoLimpo, toolRevocations: [] })).not.toContain(
      'tools_remover',
    );
  });

  it('toolRevocations só com noop (remoção já feita) é eco do plano convergido', () => {
    const plano: Plano = {
      ...planoLimpo,
      toolRevocations: [
        { name: 'crm_delete_lead', action: 'noop' },
        { name: 'cm2x9integracao0pipefy', declared: 'Pipefy', action: 'noop' },
      ],
    };

    expect(camposSemEco(AGENTE_COM_REMOCAO, plano)).not.toContain('tools_remover');
  });

  it('toolRevocations com remove é eco', () => {
    const plano: Plano = {
      ...planoLimpo,
      action: 'update',
      toolRevocations: [{ name: 'crm_delete_lead', action: 'remove' }],
    };

    expect(camposSemEco(AGENTE_COM_REMOCAO, plano)).not.toContain('tools_remover');
  });

  it('arquivo sem tools_remover não é cobrado pelo eco mesmo com Hub antigo', () => {
    expect(camposSemEco(AGENTE_SEM_REMOCAO, planoLimpo)).toEqual([]);
  });
});
