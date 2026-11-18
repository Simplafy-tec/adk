import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AgentSpecSchema,
  ToolBindingSpecSchema,
  specFieldNames,
  toAgentSpec,
} from '../src/agent-spec.js';

const agentContract = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/agent-contract.json', import.meta.url)), 'utf8'),
) as {
  alcance: {
    valores: string[];
    vinculo_valido: Record<string, unknown>;
    vinculo_integracao_valido: Record<string, unknown>;
    invalidos: { alcance: unknown }[];
  };
  agent_control: { valido: { areas: Record<string, string> } };
  tools_remover: { valido: Record<string, string>[] };
};

describe('specFieldNames — tools não vaza para definition', () => {
  it('vínculos em tools não entram na achatação de campos exportáveis', () => {
    const spec = toAgentSpec({
      agent: { name: 'Atendimento', description: 'Agente de teste' },
      slug: 'atendimento',
      tools: [{ tool: 'demo_plugin_cep', enabled: true }],
    });
    expect(spec.tools).toHaveLength(1);
    expect(specFieldNames(spec)).not.toContain('demo_plugin_cep');
    expect(specFieldNames(spec)).toEqual(['description', 'name']);
  });
});

// Hub de produção v1.574.1 (hub-v2 41d12d2): os campos novos do agente saem
// em `definition`; a credencial BYOK da Memória permanente é estado e fica.
describe('toAgentSpec — campos do agente que o Hub de produção já classifica', () => {
  it('exporta os 11 campos de definição e deixa contactMemoryModelCredentialId fora do arquivo', () => {
    const definicaoDeProd = {
      name: 'Ana',
      contactMemoryModel: 'openai/gpt-5-mini',
      contactMemoryModelSource: 'byok',
      contactMemoryRole: 'ASSISTENTE',
      contactMemoryWriteMode: 'ON_REQUEST',
      crmCamposNoTurno: ['valor_proposta', 'cidade'],
      memoryMaxTokens: 24000,
      memoryPruneToolResults: false,
      memoryTrimOldToolCalls: true,
      mergePendingMessages: true,
      ragBuscarFalaOriginal: false,
      registrarLacunas: false,
    };

    const spec = toAgentSpec({
      agent: {
        id: 'cm_agente_1',
        orgId: 'cm_org_1',
        ...definicaoDeProd,
        contactMemoryModelCredentialId: 'cm_credencial_byok_1',
      },
      slug: 'ana',
    });

    expect(spec.definition).toEqual(definicaoDeProd);
    expect(JSON.stringify(spec)).not.toContain('cm_credencial_byok_1');
  });
});

// Hub#2.6.21.83 — o JSON Schema do `get_contract` (agent) é gerado destes
// schemas zod: o que eles recusam, o contrato publicado recusa.
describe('ToolBindingSpecSchema — Alcance por tool (ADR-206)', () => {
  it.each(agentContract.alcance.valores)('aceita alcance %s num vínculo tool:', (alcance) => {
    const r = ToolBindingSpecSchema.safeParse({ tool: 'app_avaliacoes', alcance });
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { alcance?: string }).alcance).toBe(alcance);
  });

  it('aceita alcance num vínculo integration: e preserva o valor', () => {
    const r = ToolBindingSpecSchema.safeParse(agentContract.alcance.vinculo_integracao_valido);
    expect(r.success).toBe(true);
    expect(r.success && (r.data as { alcance?: string }).alcance).toBe('SO_QUEM_FALA');
  });

  it.each(agentContract.alcance.invalidos)('recusa alcance $alcance', ({ alcance }) => {
    expect(ToolBindingSpecSchema.safeParse({ tool: 'app_avaliacoes', alcance }).success).toBe(false);
  });

  it('continua estrito: chave desconhecida no vínculo é recusada', () => {
    expect(
      ToolBindingSpecSchema.safeParse({ tool: 'app_avaliacoes', escopo: 'OPERADOR' }).success,
    ).toBe(false);
  });
});

describe('AgentSpecSchema — lock on|off (trava da tela é parâmetro, padrão aberto)', () => {
  const base = { spec_version: 'v1', kind: 'agent', slug: 'ana', definition: {} };

  it.each(['on', 'off', true, false])('preserva lock: %s no spec lido (não descarta a chave)', (lock) => {
    expect((AgentSpecSchema.parse({ ...base, lock }) as { lock?: unknown }).lock).toBe(lock);
  });

  it('sem lock o spec lido segue sem a chave (padrão off é decidido pelo Hub, não inventado aqui)', () => {
    expect('lock' in AgentSpecSchema.parse(base)).toBe(false);
  });

  it.each(['talvez', 'ON', 1, null])('recusa lock fora de on | off | boolean: %j', (lock) => {
    expect(AgentSpecSchema.safeParse({ ...base, lock }).success).toBe(false);
  });
});

describe('AgentSpecSchema — áreas do Agent Control', () => {
  const base = { spec_version: 'v1', kind: 'agent', slug: 'ana', definition: {} };

  it('preserva agent_control.areas no spec lido (não descarta o bloco)', () => {
    const r = AgentSpecSchema.parse({ ...base, agent_control: agentContract.agent_control.valido });
    expect((r as { agent_control?: unknown }).agent_control).toEqual(
      agentContract.agent_control.valido,
    );
  });

  it('recusa modo de área fora de read | write | none', () => {
    expect(
      AgentSpecSchema.safeParse({ ...base, agent_control: { areas: { crm: 'admin' } } }).success,
    ).toBe(false);
  });

  it('agent_control ausente continua ausente (não vira objeto vazio)', () => {
    const r = AgentSpecSchema.parse(base);
    expect('agent_control' in r).toBe(false);
  });
});

describe('AgentSpecSchema — revogação declarada de vínculo (tools_remover)', () => {
  const base = { spec_version: 'v1', kind: 'agent', slug: 'ana', definition: {} };

  it('preserva tools_remover com `tool:` e `integration:` no spec lido (não descarta a lista)', () => {
    const r = AgentSpecSchema.parse({ ...base, tools_remover: agentContract.tools_remover.valido });
    expect((r as { tools_remover?: unknown }).tools_remover).toEqual([
      { tool: 'crm_delete_lead' },
      { integration: 'Pipefy' },
    ]);
  });

  it('recusa item de tools_remover com chave fora de tool/integration', () => {
    const r = AgentSpecSchema.safeParse({
      ...base,
      tools_remover: [{ tool: 'crm_delete_lead', motivo: 'órfão' }],
    });
    expect(r.success).toBe(false);
  });

  it('recusa item de tools_remover que declara tool e integration juntos', () => {
    const r = AgentSpecSchema.safeParse({
      ...base,
      tools_remover: [{ tool: 'crm_delete_lead', integration: 'Pipefy' }],
    });
    expect(r.success).toBe(false);
  });

  it('recusa item de tools_remover sem tool nem integration', () => {
    expect(AgentSpecSchema.safeParse({ ...base, tools_remover: [{}] }).success).toBe(false);
  });

  it('tools_remover ausente continua ausente (não vira lista vazia)', () => {
    const r = AgentSpecSchema.parse(base);
    expect('tools_remover' in r).toBe(false);
  });
});
