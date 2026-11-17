import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SPEC_KINDS,
  validateActivation,
  validateSpecStructure,
  validateSpecStructureAs,
} from '../src/index.js';

const validTool = {
  kind: 'tool' as const,
  spec_version: 'v1',
  slug: 'minha-tool',
  definition: {
    name: 'minha_tool',
    description: 'Descrição com mais de vinte caracteres para passar no portão.',
    kind: 'native',
    input_schema: { type: 'object', properties: {} },
  },
};

const validAgent = {
  kind: 'agent' as const,
  spec_version: 'v1',
  slug: 'ana',
  definition: {},
  collaborators: [],
};

const validJourney = {
  kind: 'journey' as const,
  spec_version: 'v1',
  slug: 'cadencia',
  definition: {
    name: 'Cadência',
    trigger: { type: 'cron' },
    flow: [{ id: 'inicio', type: 'start', next: 'fim' }, { id: 'fim', type: 'end' }],
  },
};

describe('validateSpecStructure — dispatcher por kind', () => {
  it('devolve invalid_document para spec vazio', () => {
    expect(validateSpecStructure(null)).toEqual([
      { code: 'invalid_document', path: '', message: expect.any(String) },
    ]);
  });

  it('devolve unknown_kind para kind não reconhecido', () => {
    const issues = validateSpecStructure({ kind: 'invented' } as never);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'unknown_kind', path: 'kind' }));
  });

  // hub#2.6.21.19 (N10) — `mcp` e `app` entraram no conjunto. A lista continua
  // TRAVADA de propósito: ela é o que separa `kind_mismatch` (kind conhecido,
  // comando errado) de `unknown_kind` (tipo que não existe), e um kind novo
  // solto aqui mudaria a mensagem que o autor recebe. Quem acrescentar um kind
  // acrescenta também o `case` no dispatcher e o teste do formato.
  // `team` entra com o ADR-290 (F1): o servidor passa a importar este conjunto do contrato na F3.
  it('SPEC_KINDS é agent|tool|journey|table|mcp|app|team', () => {
    expect(SPEC_KINDS).toEqual(['agent', 'tool', 'journey', 'table', 'mcp', 'app', 'team']);
  });

  it('kind: mcp é reconhecido — valida spec_version e slug, e NÃO exige input_schema', () => {
    expect(validateSpecStructure({ spec_version: 'v1', kind: 'mcp', slug: 'satelite' } as never)).toEqual(
      [],
    );
    expect(
      validateSpecStructure({ spec_version: 'v1', kind: 'mcp', slug: 'Satélite Inválido' } as never),
    ).toContainEqual(expect.objectContaining({ code: 'invalid_slug', path: 'slug' }));
  });
});

describe('validateSpecStructureAs — kind esperado', () => {
  it('recusa com kind_mismatch quando o arquivo declara outro kind conhecido', () => {
    const issues = validateSpecStructureAs('tool', validAgent as never);
    expect(issues).toContainEqual(expect.objectContaining({ code: 'kind_mismatch', path: 'kind' }));
  });

  it('aceita um tool spec válido sem issues', () => {
    expect(validateSpecStructureAs('tool', validTool)).toEqual([]);
  });
});

describe('validateAgentSpecStructure (via validateSpecStructureAs)', () => {
  it('missing_slug quando falta slug', () => {
    const issues = validateSpecStructureAs('agent', { ...validAgent, slug: undefined });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'missing_slug', path: 'slug' }));
  });

  it('unclassified_field para campo não classificado em definition', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      definition: { campo_inventado: true },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'unclassified_field', path: 'definition.campo_inventado' }),
    );
  });

  // Hub de produção v1.574.1 (hub-v2 41d12d2): o export de um agente com os
  // campos novos do Hub era recusado aqui com `unclassified_field`.
  it('aceita sem issue a definição exportada de prod com os campos novos do Hub', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      definition: {
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
      },
    });
    expect(issues).toEqual([]);
  });

  it('duplicate_collaborator para colaborador repetido', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      collaborators: [
        { agent: 'nina', mode: 'consult' },
        { agent: 'nina', mode: 'consult' },
      ],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'duplicate_collaborator', path: 'collaborators.1.agent' }),
    );
  });
});

describe('validateToolSpecStructure (via validateSpecStructureAs)', () => {
  it('missing_slug quando falta slug', () => {
    const issues = validateSpecStructureAs('tool', { ...validTool, slug: undefined });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'missing_slug', path: 'slug' }));
  });

  it('invalid_slug quando slug tem maiúsculas', () => {
    const issues = validateSpecStructureAs('tool', { ...validTool, slug: 'Minha-Tool' });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'invalid_slug', path: 'slug' }));
  });

  it('missing_definition quando falta o bloco definition', () => {
    const issues = validateSpecStructureAs('tool', { ...validTool, definition: undefined });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'missing_definition', path: 'definition' }),
    );
  });

  it('invalid_tool_name para nome fora do padrão snake_case', () => {
    const issues = validateSpecStructureAs('tool', {
      ...validTool,
      definition: { ...validTool.definition, name: 'Minha Tool!' },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_tool_name', path: 'definition.name' }),
    );
  });

  it('missing_description quando descrição tem menos de 20 caracteres', () => {
    const issues = validateSpecStructureAs('tool', {
      ...validTool,
      definition: { ...validTool.definition, description: 'curta' },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'missing_description', path: 'definition.description' }),
    );
  });

  it('unknown_tool_kind para kind interno desconhecido', () => {
    const issues = validateSpecStructureAs('tool', {
      ...validTool,
      definition: { ...validTool.definition, kind: 'invented' },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'unknown_tool_kind', path: 'definition.kind' }),
    );
  });

  it('invalid_scope quando o arquivo de organização declara escopo diferente de org', () => {
    const issues = validateSpecStructureAs('tool', { ...validTool, definition: { ...validTool.definition, scope: 'global' } });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_scope', path: 'definition.scope' }),
    );
  });

  it('invalid_input_schema quando input_schema não é um JSON Schema de objeto', () => {
    const issues = validateSpecStructureAs('tool', {
      ...validTool,
      definition: { ...validTool.definition, input_schema: { type: 'string' } },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_input_schema', path: 'definition.input_schema' }),
    );
  });

  it('invalid_connection quando connections não é lista de slugs', () => {
    const issues = validateSpecStructureAs('tool', { ...validTool, connections: 'não-lista' as never });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'invalid_connection', path: 'connections' }));
  });
});

describe('validateJourneySpecStructure (via validateSpecStructureAs)', () => {
  it('missing_name quando falta definition.name', () => {
    const issues = validateSpecStructureAs('journey', {
      ...validJourney,
      definition: { ...validJourney.definition, name: '' },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'missing_name', path: 'definition.name' }),
    );
  });

  it('missing_trigger quando falta trigger.type', () => {
    const issues = validateSpecStructureAs('journey', {
      ...validJourney,
      definition: { ...validJourney.definition, trigger: {} },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'missing_trigger', path: 'definition.trigger' }),
    );
  });

  it('missing_flow quando flow está vazio', () => {
    const issues = validateSpecStructureAs('journey', {
      ...validJourney,
      definition: { ...validJourney.definition, flow: [] },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'missing_flow', path: 'definition.flow' }),
    );
  });

  it('missing_node_id para nó sem id', () => {
    const issues = validateSpecStructureAs('journey', {
      ...validJourney,
      definition: { ...validJourney.definition, flow: [{ type: 'start' }] },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'missing_node_id', path: 'definition.flow.0.id' }),
    );
  });

  it('duplicate_node_id para dois nós com o mesmo id', () => {
    const issues = validateSpecStructureAs('journey', {
      ...validJourney,
      definition: {
        ...validJourney.definition,
        flow: [
          { id: 'a', type: 'start' },
          { id: 'a', type: 'end' },
        ],
      },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'duplicate_node_id', path: 'definition.flow.1.id' }),
    );
  });

  it('missing_node_type para nó sem type', () => {
    const issues = validateSpecStructureAs('journey', {
      ...validJourney,
      definition: { ...validJourney.definition, flow: [{ id: 'a' }] },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'missing_node_type', path: 'definition.flow.0.type' }),
    );
  });

  it('unknown_edge_target quando a aresta aponta para nó inexistente', () => {
    const issues = validateSpecStructureAs('journey', {
      ...validJourney,
      definition: {
        ...validJourney.definition,
        flow: [{ id: 'a', type: 'start', next: 'nao-existe' }],
      },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'unknown_edge_target', path: 'definition.flow.0.next' }),
    );
  });

  it('unknown_reference_field para chave de references não reconhecida', () => {
    const issues = validateSpecStructureAs('journey', {
      ...validJourney,
      definition: {
        ...validJourney.definition,
        trigger: { type: 'cron', references: { campo_inventado: 'x' } },
      },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'unknown_reference_field' }),
    );
  });

  it('invalid_reference_value quando references não é mapa ou valor é vazio', () => {
    const issues = validateSpecStructureAs('journey', {
      ...validJourney,
      definition: { ...validJourney.definition, trigger: { type: 'cron', references: [] } },
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'invalid_reference_value' }));
  });

  it('status_not_allowed quando overridable.status não é DRAFT nem PAUSED', () => {
    const issues = validateSpecStructureAs('journey', {
      ...validJourney,
      overridable: { status: 'ACTIVE' },
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'status_not_allowed', path: 'overridable.status' }),
    );
  });
});


// Hub#2.6.26.22 — "Como chamar quem não tem nome" (`definition.fallbackContactName`). Mesma régua do servidor
// (hub-v2 `spec-gates.ts` e o DTO do produto): texto aparado de 1 a 60 caracteres. É o que faz `adk validate`
// recusar localmente, antes de o arquivo chegar ao Hub.
describe('validateJourneySpecStructure — fallbackContactName', () => {
  const comNome = (valor: unknown) =>
    ({ ...validJourney, definition: { ...validJourney.definition, fallbackContactName: valor } }) as never;
  const issueDoCampo = (valor: unknown) =>
    validateSpecStructureAs('journey', comNome(valor)).find(
      (i) => i.path === 'definition.fallbackContactName',
    );

  it('aceita a palavra declarada, com ou sem espaços nas pontas', () => {
    expect(validateSpecStructureAs('journey', comNome('produtor'))).toEqual([]);
    expect(validateSpecStructureAs('journey', comNome('  produtor  '))).toEqual([]);
  });

  it('aceita os limites: 1 e 60 caracteres (60 contado depois de aparar)', () => {
    expect(validateSpecStructureAs('journey', comNome('a'))).toEqual([]);
    expect(validateSpecStructureAs('journey', comNome(`  ${'a'.repeat(60)}  `))).toEqual([]);
  });

  it('ausente não é issue', () => {
    expect(validateSpecStructureAs('journey', validJourney)).toEqual([]);
  });

  it.each([
    ['vazio', ''],
    ['só espaços', '   '],
  ])('recusa %s com mensagem em pt-BR', (_caso, valor) => {
    expect(issueDoCampo(valor)).toEqual({
      code: 'invalid_fallback_contact_name',
      path: 'definition.fallbackContactName',
      message: expect.stringMatching(/vazi/i),
    });
  });

  it('recusa acima de 60 caracteres', () => {
    expect(issueDoCampo('a'.repeat(61))).toEqual({
      code: 'invalid_fallback_contact_name',
      path: 'definition.fallbackContactName',
      message: expect.stringContaining('60 caracteres'),
    });
  });

  it.each([
    ['número', 42],
    ['lista', ['produtor']],
    ['nulo', null],
  ])('recusa valor que não é texto (%s)', (_caso, valor) => {
    expect(issueDoCampo(valor)?.code).toBe('invalid_fallback_contact_name');
  });
});

describe('validateAgentSpecStructure — tools (hub#2.7.13.4 / issue#2763)', () => {
  it('spec sem tools continua passando (compatibilidade)', () => {
    expect(validateSpecStructureAs('agent', validAgent)).toEqual([]);
  });

  it('aceita vínculo tool com nome interno snake_case', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      tools: [{ tool: 'demo_plugin_cep', enabled: true }],
    });
    expect(issues).toEqual([]);
  });

  it('invalid_tool_binding quando tools é lista de strings (slug com hífen)', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      tools: ['demo-plugin-cep'] as never,
    });
    expect(issues).toContainEqual({
      code: 'invalid_tool_binding',
      path: 'tools[0]',
      message: 'Vínculo 0 ilegível.',
    });
  });

  it('invalid_tool_binding quando tool usa slug com hífen em vez de nome interno', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      tools: [{ tool: 'demo-plugin-cep', enabled: true }],
    });
    expect(issues).toContainEqual({
      code: 'invalid_tool_binding',
      path: 'tools[0].tool',
      message:
        'Nome de tool inválido: demo-plugin-cep — snake_case, 3–64 caracteres, iniciando por letra.',
    });
  });

  it('invalid_tool_binding quando declara tool E integration no mesmo vínculo', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      tools: [{ tool: 'minha_tool', integration: 'pipefy' }],
    });
    expect(issues).toContainEqual({
      code: 'invalid_tool_binding',
      path: 'tools[0]',
      message: 'Cada vínculo declara `tool` OU `integration` — nunca os dois, nunca nenhum.',
    });
  });


  it('aceita vínculo integration com allowed_actions explícito', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      tools: [{ integration: 'pipefy', allowed_actions: ['list_cards'], enabled: true }],
    });
    expect(issues).toEqual([]);
  });

  it('invalid_tool_binding quando integration não declara allowed_actions', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      tools: [{ integration: 'pipefy' }],
    });
    expect(issues).toContainEqual({
      code: 'invalid_tool_binding',
      path: 'tools[0].allowed_actions',
      message:
        'integration: pipefy exige allowed_actions explícito — sem a lista, o agente receberia todas as ações da integração.',
    });
  });

  it('reserved_tool_name para sentinela CRM derivada do toggle', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      tools: [{ tool: '__crm_native_tools__' }],
    });
    expect(issues).toContainEqual({
      code: 'reserved_tool_name',
      path: 'tools[0].tool',
      message:
        '"__crm_native_tools__" é derivada do toggle de CRM do agente e não pode ser declarada em tools.',
    });
  });

  it('duplicate_tool_binding para o mesmo tool declarado duas vezes', () => {
    const issues = validateSpecStructureAs('agent', {
      ...validAgent,
      tools: [
        { tool: 'demo_plugin_cep', enabled: true },
        { tool: 'demo_plugin_cep', enabled: false },
      ],
    });
    expect(issues).toContainEqual({
      code: 'duplicate_tool_binding',
      path: 'tools[1]',
      message: 'Vínculo declarado duas vezes: demo_plugin_cep.',
    });
  });

  // Prova invertida (issue#2763): sem toolBindingIssues no portão, este teste fica verde
  // com tools: ['demo-plugin-cep'] — o formato errado passaria.
  it('prova invertida — lista de slug com hífen é bloqueada (desfazer toolBindingIssues → vermelho)', () => {
    const issues = validateSpecStructure({
      kind: 'agent',
      spec_version: 'v1',
      slug: 'atendimento',
      definition: {},
      tools: ['demo-plugin-cep'] as never,
    });
    expect(issues.some((i) => i.code === 'invalid_tool_binding' && i.path === 'tools[0]')).toBe(
      true,
    );
  });
});

describe('validateActivation — portão 2', () => {
  it('unresolved_reference para pendência not_found', () => {
    const issues = validateActivation({
      spec: { slug: 'ana', definition: {}, collaborators: [] },
      pending: [{ field: 'pipelineId', slug: 'funil-x', reason: 'not_found' }],
    });
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'unresolved_reference', path: 'references.pipelineId' }),
    );
  });

  it('collaborator_cycle quando a composição formaria um laço', () => {
    const issues = validateActivation({
      spec: { slug: 'a', definition: {}, collaborators: [{ agent: 'b', mode: 'consult' }] },
      compositionEdges: { b: ['a'] },
    });
    expect(issues).toContainEqual(expect.objectContaining({ code: 'collaborator_cycle' }));
  });
});

// Hub#2.6.21.83 — campos de definição, Alcance por tool (ADR-206) e áreas do
// Agent Control. Os casos vêm da fixture de contrato replicada VERBATIM do
// hub-v2 (apps/api/src/adk/fixtures/agent-contract.json): o portão do Hub roda
// os MESMOS casos e tem de devolver os MESMOS códigos.
type CasoInvalido = { campo: string; valor: unknown; code: string };
const agentContract = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/agent-contract.json', import.meta.url)), 'utf8'),
) as {
  definicao: {
    valida: Record<string, unknown>;
    validos_extra: { campo: string; valor: unknown }[];
    invalidos: CasoInvalido[];
  };
  alcance: {
    valores: string[];
    vinculo_valido: Record<string, unknown>;
    vinculo_integracao_valido: Record<string, unknown>;
    invalidos: { alcance: unknown; code: string }[];
  };
  agent_control: {
    valido: Record<string, unknown>;
    invalidos: { agent_control: unknown; code: string; path: string }[];
  };
  tools_remover: {
    valido: unknown[];
    invalidos: { tools_remover: unknown; tools?: unknown[]; code: string; path: string }[];
  };
};

function agenteCom(extra: Record<string, unknown>) {
  return { ...validAgent, ...extra };
}

describe('validateAgentSpecStructure — campos de definição do contrato (agent-contract.json)', () => {
  it('aceita crmFunctions, executionPolicy, executionZdr e modelSource com valores válidos', () => {
    const issues = validateSpecStructureAs(
      'agent',
      agenteCom({ definition: agentContract.definicao.valida }),
    );
    expect(issues).toEqual([]);
  });

  it.each(agentContract.definicao.validos_extra)(
    'aceita $campo = $valor',
    ({ campo, valor }) => {
      expect(validateSpecStructureAs('agent', agenteCom({ definition: { [campo]: valor } }))).toEqual(
        [],
      );
    },
  );

  it.each(agentContract.definicao.invalidos)(
    'recusa $campo = $valor com $code ancorado em definition.$campo',
    ({ campo, valor, code }) => {
      const issues = validateSpecStructureAs('agent', agenteCom({ definition: { [campo]: valor } }));
      expect(issues).toContainEqual(expect.objectContaining({ code, path: `definition.${campo}` }));
    },
  );
});

describe('validateAgentSpecStructure — Alcance no vínculo de tool (ADR-206)', () => {
  it.each(agentContract.alcance.valores)('aceita alcance %s num vínculo tool:', (alcance) => {
    const issues = validateSpecStructureAs(
      'agent',
      agenteCom({ tools: [{ tool: 'app_avaliacoes', alcance }] }),
    );
    expect(issues).toEqual([]);
  });

  it('aceita alcance num vínculo integration: com allowed_actions', () => {
    const issues = validateSpecStructureAs(
      'agent',
      agenteCom({ tools: [agentContract.alcance.vinculo_integracao_valido] }),
    );
    expect(issues).toEqual([]);
  });

  it.each(agentContract.alcance.invalidos)(
    'recusa alcance $alcance com $code ancorado em tools[0].alcance',
    ({ alcance, code }) => {
      const issues = validateSpecStructureAs(
        'agent',
        agenteCom({ tools: [{ tool: 'app_avaliacoes', alcance }] }),
      );
      expect(issues).toContainEqual(expect.objectContaining({ code, path: 'tools[0].alcance' }));
    },
  );
});

describe('validateAgentSpecStructure — áreas do Agent Control (agent_control.areas)', () => {
  it('aceita agent_control.areas com read, write e none', () => {
    const issues = validateSpecStructureAs(
      'agent',
      agenteCom({ agent_control: agentContract.agent_control.valido }),
    );
    expect(issues).toEqual([]);
  });

  it('agente sem agent_control continua válido (bloco ausente = silêncio)', () => {
    expect(validateSpecStructureAs('agent', validAgent)).toEqual([]);
  });

  it.each(agentContract.agent_control.invalidos)(
    'recusa agent_control malformado com $code em $path',
    ({ agent_control, code, path }) => {
      const issues = validateSpecStructureAs('agent', agenteCom({ agent_control }));
      expect(issues).toContainEqual(expect.objectContaining({ code, path }));
    },
  );
});

// Revogação declarada de vínculo: os casos compartilhados vêm da fixture de
// contrato (seção `tools_remover`); as bordas abaixo dela provam a regra, não só
// o código devolvido — as mesmas do spec-gates.spec.ts do hub-v2.
describe('validateAgentSpecStructure — revogação de vínculo (tools_remover)', () => {
  it('aceita tools_remover com `tool:` e `integration:`', () => {
    const issues = validateSpecStructureAs(
      'agent',
      agenteCom({ tools_remover: agentContract.tools_remover.valido }),
    );
    expect(issues).toEqual([]);
  });

  it.each(agentContract.tools_remover.invalidos)(
    'recusa tools_remover com $code em $path',
    ({ tools_remover, tools, code, path }) => {
      const issues = validateSpecStructureAs(
        'agent',
        agenteCom({ tools_remover, ...(tools ? { tools } : {}) }),
      );
      expect(issues).toContainEqual(expect.objectContaining({ code, path }));
    },
  );

  it('aprova revogação ao lado de `tools:` sem contradição', () => {
    const issues = validateSpecStructureAs(
      'agent',
      agenteCom({
        tools: [
          { tool: 'acme_simulacao_avaliar', enabled: true },
          { integration: 'Google Agenda', allowed_actions: ['criar_evento'] },
        ],
        tools_remover: [{ tool: 'crm_delete_lead' }, { integration: 'Pipefy' }],
      }),
    );
    expect(issues).toEqual([]);
  });

  it('sentinela reservada é `reserved_tool_name`, não `invalid_tool_revocation` pelo regex', () => {
    const issues = validateSpecStructureAs(
      'agent',
      agenteCom({ tools_remover: [{ tool: '__crm_native_tools__' }] }),
    );
    expect(issues.map((i) => i.code)).toEqual(['reserved_tool_name']);
  });

  it('`AGENT_CONTROL` é reservado em qualquer caixa (o serviço compara em maiúsculas)', () => {
    const issues = validateSpecStructureAs(
      'agent',
      agenteCom({ tools_remover: [{ tool: 'agent_control' }] }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'reserved_tool_name', path: 'tools_remover[0].tool' }),
    );
  });

  it('duplicata de `integration:` compara pelo nome normalizado (mesma regra de `tools:`)', () => {
    const issues = validateSpecStructureAs(
      'agent',
      agenteCom({
        tools_remover: [{ integration: 'Google Agenda' }, { integration: 'google-agenda' }],
      }),
    );
    expect(issues).toContainEqual(
      expect.objectContaining({ code: 'invalid_tool_revocation', path: 'tools_remover[1]' }),
    );
  });

  it('`tool:` e `integration:` de mesmo texto não são contradição — eixos diferentes', () => {
    const issues = validateSpecStructureAs(
      'agent',
      agenteCom({
        tools: [{ integration: 'Pipefy', allowed_actions: ['get_cards'] }],
        tools_remover: [{ tool: 'pipefy' }],
      }),
    );
    expect(issues.map((i) => i.code)).not.toContain('tool_binding_contradiction');
  });

  it('agente sem tools_remover não ganha issue nenhuma de revogação', () => {
    expect(validateSpecStructureAs('agent', validAgent)).toEqual([]);
  });
});
