import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AGENT_FIELD_GROUPS, AGENT_VIRTUAL_FIELDS, isExportedField } from '../src/index.js';

// Fixture de contrato replicada VERBATIM do hub-v2
// (apps/api/src/adk/fixtures/agent-contract.json). O Hub testa a classificação
// dele contra o MESMO arquivo: um lado que andar sozinho quebra aqui ou lá.
const contrato = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/agent-contract.json', import.meta.url)), 'utf8'),
) as { field_groups: Record<string, string>; virtual_fields: string[] };

function ordenado(tabela: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.keys(tabela)
      .sort()
      .map((campo) => [campo, tabela[campo] as string]),
  );
}

describe('AGENT_FIELD_GROUPS — contrato público alinhado ao Hub', () => {
  it('é idêntico à classificação do Hub, campo a campo e grupo a grupo', () => {
    expect(ordenado(AGENT_FIELD_GROUPS)).toEqual(ordenado(contrato.field_groups));
  });

  it('AGENT_VIRTUAL_FIELDS é a lista nomeada do Hub: só crmAlcance não é coluna do Agent', () => {
    expect([...AGENT_VIRTUAL_FIELDS].sort()).toEqual([...contrato.virtual_fields].sort());
    expect([...AGENT_VIRTUAL_FIELDS]).toEqual(['crmAlcance']);
  });

  it.each(['crmAlcance', 'crmFunctions', 'executionPolicy', 'executionZdr', 'modelSource'])(
    '%s é definição e atravessa a fronteira para o arquivo',
    (campo) => {
      expect(AGENT_FIELD_GROUPS[campo]).toBe('definition');
      expect(isExportedField(campo)).toBe(true);
    },
  );

  it.each(['managedBy', 'sourceRef', 'specHash', 'lockedFields', 'managedAt'])(
    'o marcador de gestão %s é estado e nunca vai para o arquivo',
    (campo) => {
      expect(AGENT_FIELD_GROUPS[campo]).toBe('state');
      expect(isExportedField(campo)).toBe(false);
    },
  );
});

// Hub de produção v1.574.1 (hub-v2 41d12d2): 12 campos do agente que o Hub
// classifica e o ADK não conhecia. Export de prod com qualquer um deles saía
// do `adk validate` recusado com `unclassified_field`.
describe('AGENT_FIELD_GROUPS — campos do agente que o Hub de produção já classifica', () => {
  it.each([
    'contactMemoryModel',
    'contactMemoryModelSource',
    'contactMemoryRole',
    'contactMemoryWriteMode',
    'crmCamposNoTurno',
    'memoryMaxTokens',
    'memoryPruneToolResults',
    'memoryTrimOldToolCalls',
    'mergePendingMessages',
    'ragBuscarFalaOriginal',
    'registrarLacunas',
  ])('%s é definição e atravessa a fronteira para o arquivo', (campo) => {
    expect(AGENT_FIELD_GROUPS[campo]).toBe('definition');
    expect(isExportedField(campo)).toBe(true);
  });

  // Diferente de modelCredentialId (reference, sai por slug), a credencial
  // BYOK da Memória permanente é estado no Hub: nunca vai para o arquivo.
  it('contactMemoryModelCredentialId é estado e nunca vai para o arquivo', () => {
    expect(AGENT_FIELD_GROUPS.contactMemoryModelCredentialId).toBe('state');
    expect(isExportedField('contactMemoryModelCredentialId')).toBe(false);
  });
});
