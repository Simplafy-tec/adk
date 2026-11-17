/**
 * ADK — forma declarativa do agente.
 *
 * Porte fiel de `apps/api/src/adk/agent-export.ts` (hub-v2, origin/staging):
 * só as partes puras (tipos, allowlist de export e `toAgentSpec`). A cópia de
 * campos é por ALLOWLIST (o que está classificado como exportável), nunca por
 * exclusão do que se conhece: assim um campo novo — inclusive contexto de turno
 * que apareça no objeto de entrada — fica de fora por omissão.
 */

import { z } from 'zod';
import { AGENT_FIELD_GROUPS, isExportedField } from './agent-fields.js';

export const AGENT_SPEC_VERSION = 'v1';

/** Nomes de referência no arquivo: slug legível no lugar do cuid. */
export const REFERENCE_FIELD_NAMES: Readonly<Record<string, string>> = {
  pipelineId: 'pipeline',
  channelId: 'channel',
  modelCredentialId: 'model_credential',
  accessOnboardingAgentId: 'access_onboarding_agent',
  accessListIntegrationId: 'access_list_integration',
  accessListSourceId: 'access_list_source',
};

export type CollaboratorMode = 'consult' | 'transfer';
export type OrchestrationStyle = 'supervisor' | 'tasks';

/**
 * Sentinela derivada de `definition.crmEnabled` — espelho de
 * `crm-agent-perms.ts` (hub-v2). Não pode ser declarada em `tools:`.
 */
export const CRM_AGENT_TOOL_NAME = '__crm_native_tools__';

/** Sentinela das Jornadas do agente — espelho de `journey-agent-tool.ts` (hub-v2). */
export const JOURNEY_AGENT_TOOL_NAME = '__journey_tools__';

/** Linha do Agent Control — espelho de `agent-control-eligibility.ts` (hub-v2). */
export const AGENT_CONTROL_TOOL_NAME = 'AGENT_CONTROL';

/**
 * Alcance da tool no agente (ADR-206): em nome de quem o agente lê e escreve
 * com ela. Ausência = `SO_QUEM_FALA`.
 */
export const ALCANCES = ['SO_QUEM_FALA', 'PARCEIRO', 'OPERADOR'] as const;
export type Alcance = (typeof ALCANCES)[number];

/** Acesso do agente a uma área do Hub pelo Agent Control. `none` desliga a área. */
export const AGENT_CONTROL_MODES = ['read', 'write', 'none'] as const;
export type AgentControlMode = (typeof AGENT_CONTROL_MODES)[number];

/**
 * hub#2.6.21.11 — vínculo agente↔tool declarado no arquivo.
 *
 * `tool` XOR `integration`: o primeiro é o nome no registro (snake_case ou o
 * nome público namespaced de um servidor MCP, `<server>__<tool>`), o segundo é o
 * NOME da Integration da org — nunca o id, que só existe no ambiente de origem.
 * `connection` é o slug da Connection que o agente passa a poder usar.
 */
export interface ToolBindingSpec {
  tool?: string;
  integration?: string;
  connection?: string;
  enabled?: boolean;
  mcp_tool_names?: string[];
  allowed_actions?: string[];
  /**
   * Alcance da tool no agente (ADR-206): `SO_QUEM_FALA` (padrão), `PARCEIRO`
   * ou `OPERADOR`. Ausente preserva o gravado. Só nas tools que lidam com dado
   * de pessoa; o do CRM é `definition.crmAlcance`.
   */
  alcance?: Alcance;
}

/**
 * Revogação declarada de UM vínculo (`tools_remover`): `tool` XOR
 * `integration`, sem outras chaves. É o único caminho do arquivo para apagar
 * um vínculo que o ADK não gerencia — nunca a ausência em `tools:`.
 */
export interface ToolRevocationSpec {
  tool?: string;
  integration?: string;
}

/**
 * Áreas do Hub que o agente alcança pelo Agent Control — espelho do corpo
 * `escopos` do `PUT /agents/:agentId/agent-control/areas`. `none` desliga.
 */
export interface AgentControlSpec {
  areas: Record<string, AgentControlMode>;
}

export interface CollaboratorSpec {
  agent: string;
  when_to_use?: string;
  mode: CollaboratorMode;
  /**
   * Divergência DELIBERADA do arquivo do hub-v2, onde os dois são obrigatórios:
   * lá o spec nasce do export (o banco sempre tem os valores), aqui ele nasce
   * do YAML escrito à mão, que costuma declarar só `agent` e `mode`. Ausente =
   * preserva o que está gravado; nem a CLI nem o contrato inventam ordem.
   */
  order?: number;
  enabled?: boolean;
  /** Espelha `AgentSubAgent.registerResult`; omitido preserva o valor gravado. */
  register_result?: boolean;
}

export interface AgentSpec {
  spec_version: string;
  kind: 'agent';
  slug: string;
  style: OrchestrationStyle;
  definition: Record<string, unknown>;
  overridable: Record<string, unknown>;
  references: Record<string, string>;
  collaborators: CollaboratorSpec[];
  /**
   * hub#2.6.21.11 — vínculos de tool. AUSENTE (undefined) = o arquivo está
   * calado sobre os vínculos e nada é tocado; `[]` explícito remove os que o
   * ADK gerencia.
   */
  tools?: ToolBindingSpec[];
  /** Vínculos a apagar, inclusive os da tela. Remover o que não existe é `noop`. */
  tools_remover?: ToolRevocationSpec[];
  /** Ausente = as áreas gravadas pela tela são preservadas. */
  agent_control?: AgentControlSpec;
}

const AlcanceSchema = z.enum(ALCANCES);

const DESCRICAO_ALCANCE =
  'Alcance da tool no agente: SO_QUEM_FALA (padrão, só os registros da pessoa da conversa), ' +
  'PARCEIRO (os ligados ao parceiro da conversa) ou OPERADOR (a equipe opera em nome dos clientes; ' +
  'exige Controle de acesso em Lista fechada e agente sem Web Chat). Ausente preserva o gravado. ' +
  'Só em tools que lidam com dado de pessoa; o do CRM é definition.crmAlcance.';

/** Vínculo por tool do registro ou nome MCP namespaced — sem `integration`. */
const ToolBindingByToolSchema = z
  .object({
    tool: z.string().min(1),
    connection: z.string().optional(),
    enabled: z.boolean().optional(),
    mcp_tool_names: z.array(z.string().min(1)).optional(),
    alcance: AlcanceSchema.optional().describe(DESCRICAO_ALCANCE),
  })
  .strict();

/** Vínculo por integração da org — `allowed_actions` obrigatório no portão 1. */
const ToolBindingByIntegrationSchema = z
  .object({
    integration: z.string().min(1),
    connection: z.string().optional(),
    enabled: z.boolean().optional(),
    allowed_actions: z.array(z.string().min(1)).min(1),
    alcance: AlcanceSchema.optional().describe(DESCRICAO_ALCANCE),
  })
  .strict();

/** XOR `tool` | `integration` — espelha portão 1 e o JSON Schema do `get_contract`. */
export const ToolBindingSpecSchema = z.union([
  ToolBindingByToolSchema,
  ToolBindingByIntegrationSchema,
]);

const DESCRICAO_TOOLS_REMOVER =
  'Vínculos a apagar do agente, inclusive os criados pela tela: cada item declara tool (nome no ' +
  'registro) ou integration (nome da integração da org). O mesmo nome em tools e tools_remover é ' +
  'recusado; remover o que já não existe não faz nada.';

/** Item de `tools_remover` — `tool` XOR `integration`, sem outras chaves. */
export const ToolRevocationSpecSchema = z.union([
  z.object({ tool: z.string().min(1) }).strict(),
  z.object({ integration: z.string().min(1) }).strict(),
]);

export const AgentControlSpecSchema = z
  .object({ areas: z.record(z.enum(AGENT_CONTROL_MODES)) })
  .strict()
  .describe(
    'Áreas do Hub que o agente alcança pelo Agent Control ({ <área>: read | write | none }), as ' +
      'mesmas da tela. Ausente preserva as áreas gravadas. Exige o Agent Control ligado na ' +
      'organização e papel de quem aplica igual ou maior que o do responsável.',
  );

export const CollaboratorSpecSchema = z.object({
  agent: z.string().min(1),
  when_to_use: z.string().optional(),
  mode: z.enum(['consult', 'transfer']),
  order: z.number().int().optional(),
  enabled: z.boolean().optional(),
  register_result: z.boolean().optional(),
});

/**
 * Envelope zod do agente — permissivo em PARÂMETRO (definition passa cru) e
 * estrito na identidade, igual ao portão 1 do ADR-107. Quem julga o conteúdo de
 * `definition` é `validateAgentSpecStructure`, que devolve `SpecIssue[]`
 * ancorado no campo em vez de uma exceção sem endereço.
 */
export const AgentSpecSchema = z.object({
  spec_version: z.string(),
  kind: z.literal('agent'),
  slug: z.string().min(1),
  style: z.enum(['supervisor', 'tasks']).optional(),
  definition: z
    .record(z.unknown())
    .default({})
    .describe(
      'Campos classificados como definition em AGENT_FIELD_GROUPS. Valor fechado: executionPolicy ' +
        '(recomendado | rapido | barato | eu-escolho), executionZdr (boolean), modelSource ' +
        '(simplafy | byok | null), crmFunctions (lista de ids de função do CRM), crmAlcance ' +
        '(SO_QUEM_FALA | PARCEIRO | OPERADOR).',
    ),
  overridable: z.record(z.unknown()).optional(),
  references: z.record(z.string()).optional(),
  collaborators: z.array(CollaboratorSpecSchema).optional(),
  tools: z.array(ToolBindingSpecSchema).optional(),
  tools_remover: z.array(ToolRevocationSpecSchema).optional().describe(DESCRICAO_TOOLS_REMOVER),
  agent_control: AgentControlSpecSchema.optional(),
  prompt_file: z.string().optional(),
});

export interface ExportAgentInput {
  agent: Record<string, unknown>;
  slug: string;
  referenceSlugs?: Readonly<Record<string, string | null | undefined>>;
  collaborators?: readonly CollaboratorSpec[];
  style?: OrchestrationStyle;
  tools?: readonly ToolBindingSpec[];
}

/** O identificador declarado do vínculo — é por ele que a ordem é estável. */
function identificadorDoVinculo(b: ToolBindingSpec): string {
  return b.tool ?? b.integration ?? '';
}

export function toAgentSpec(input: ExportAgentInput): AgentSpec {
  const definition: Record<string, unknown> = {};
  const overridable: Record<string, unknown> = {};
  const references: Record<string, string> = {};

  for (const [field, value] of Object.entries(input.agent)) {
    if (!isExportedField(field)) continue;

    const group = AGENT_FIELD_GROUPS[field];

    if (group === 'reference') {
      const slug = input.referenceSlugs?.[field];
      // Sem slug resolvido a referência some do arquivo. Exportar o cuid faria
      // o arquivo só funcionar no ambiente de origem — o problema que a forma
      // declarativa existe para resolver.
      if (typeof slug === 'string' && slug.length > 0) {
        references[REFERENCE_FIELD_NAMES[field]] = slug;
      }
      continue;
    }

    if (value === undefined) continue;

    if (group === 'overridable') {
      overridable[field] = value;
    } else {
      definition[field] = value;
    }
  }

  const tools = [...(input.tools ?? [])].sort((a, b) =>
    identificadorDoVinculo(a).localeCompare(identificadorDoVinculo(b)),
  );

  return {
    spec_version: AGENT_SPEC_VERSION,
    kind: 'agent',
    slug: input.slug,
    style: input.style ?? 'supervisor',
    definition,
    overridable,
    references,
    collaborators: [...(input.collaborators ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/** Achata o spec para varredura — usado pelo teste de vazamento. */
export function specFieldNames(spec: AgentSpec): string[] {
  return [
    ...Object.keys(spec.definition),
    ...Object.keys(spec.overridable),
    ...Object.keys(spec.references),
  ].sort();
}
