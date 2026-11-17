/**
 * ADK — portões de save e de ativação (porte fiel de `apps/api/src/adk/
 * spec-gates.ts` do hub-v2, origin/staging).
 *
 * Os três portões do ADR-107 §1 foram escritos para grafo de jornada. Aqui eles
 * valem para agente, tool e jornada, com a mesma divisão de responsabilidade:
 *
 *   Portão 1 (save/import) — permissivo em parâmetro, estrito em ESTRUTURA.
 *   Portão 2 (ativação) — é aqui que a validação morde.
 *
 * O erro é estruturado com código ESTÁVEL, porque serve a dois consumidores ao
 * mesmo tempo: a tela, que ancora a mensagem no campo, e o agente de IA que
 * constrói configuração e precisa se autocorrigir sem reinterpretar texto.
 * Mensagens e `path` são byte a byte os do servidor: é o que permite ao
 * `adk build` reprovar exatamente o que o apply reprovaria.
 */

import { JsonSchemaObjeto, TOOL_KINDS, TOOL_NAME_REGEX } from './tool-contract.js';
import {
  AGENT_CONTROL_MODES,
  AGENT_CONTROL_TOOL_NAME,
  ALCANCES,
  CRM_AGENT_TOOL_NAME,
  JOURNEY_AGENT_TOOL_NAME,
  type Alcance,
  type AgentSpec,
  type CollaboratorSpec,
  type ToolBindingSpec,
} from './agent-spec.js';
import { ADK_MARCADOR_FIELDS, AGENT_FIELD_GROUPS } from './agent-fields.js';
import {
  FALLBACK_CONTACT_NAME_MAX,
  REFERENCE_FIELD_KIND,
  type JourneyFlowNode,
  type JourneySpec,
} from './journey-spec.js';
import { toSlug } from './reference-resolver.js';
import type { ToolSpec } from './tool-spec.js';
import { validateTeamSpecStructure } from './team-spec.js';

/**
 * Versão do contrato de especificação. `SUPPORTED_SPEC_VERSIONS` é a janela N e
 * N-1 — hoje só `v1` existe, então a janela tem um elemento; quando `v2` nascer,
 * `v1` continua aceito e é aqui que a compatibilidade fica declarada.
 */
export const SPEC_VERSION = 'v1';
export const SUPPORTED_SPEC_VERSIONS: readonly string[] = [SPEC_VERSION];

/**
 * União FECHADA dos códigos de erro do contrato. Fechada de propósito: o
 * servidor e a CLI têm de reprovar a mesma coisa com o mesmo nome, e um código
 * inventado de um lado só é descoberto quando alguém compara os dois.
 *
 * Os 29 primeiros são os do portão do hub-v2; os 5 seguintes vêm do portão do
 * repositório de clientes (`scanLeaks`); `package_too_large` é da política
 * (`checkAgainstPolicy`) e os 4 últimos são do portão local da CLI (leitura do
 * `prompt_file` e amarração de tenant do `org.yaml`) — nenhum desses dois
 * grupos tem emissor no servidor.
 *
 * `limits_over_budget` de tool `runtime: script` é emitido dos DOIS lados, com
 * o mesmo path (`definition.limits`) e a mesma regra: na CLI por
 * `checkScriptLimits` (no `adk build`) e no hub-v2 pelo portão do apply
 * (`spec-gates.ts`, com `limitesForaDoTeto` de `adk-policy.ts`). O hub-v2 também
 * emite o código, com path `limits`, para table, mcp e app; a CLI ainda não
 * confere essas classes.
 *
 * `subagent_reference_conflict` e `tool_name_collision` também não são emitidos
 * por este pacote: quem os produz é o `AdkService` do hub-v2 (`adk.service.ts`),
 * que só descobre a colisão contra o que JÁ está gravado na organização. Estão
 * na união porque a CLI recebe esses códigos em `blocking[]` na resposta do
 * apply e precisa nomeá-los com o mesmo tipo.
 */
export type SpecIssueCode =
  | 'invalid_document'
  | 'unknown_kind'
  | 'kind_mismatch'
  | 'unknown_spec_version'
  | 'missing_slug'
  | 'unclassified_field'
  | 'state_field_not_writable'
  | 'invalid_field_value'
  | 'invalid_agent_control'
  | 'duplicate_collaborator'
  | 'invalid_tool_binding'
  | 'reserved_tool_name'
  | 'invalid_tool_revocation'
  | 'tool_binding_contradiction'
  | 'duplicate_tool_binding'
  // Revogação julgada contra o banco (servidor — `resolverRevogacoes`/`planToolRevocations`).
  | 'ambiguous_tool_revocation'
  | 'tool_revocation_managed_elsewhere'
  // Portão 2 (servidor — `resolverVinculos`): ação/MCP fora do catálogo.
  // Nunca emitido por `validateSpecStructure` deste pacote; está na união porque
  // a CLI recebe `blocking[]` do apply e precisa nomear o código.
  | 'unknown_tool_action'
  | 'invalid_slug'
  | 'missing_definition'
  | 'invalid_tool_name'
  | 'missing_description'
  | 'unknown_tool_kind'
  | 'invalid_scope'
  | 'invalid_input_schema'
  | 'invalid_connection'
  | 'missing_name'
  | 'missing_trigger'
  | 'missing_flow'
  | 'missing_node_id'
  | 'duplicate_node_id'
  | 'missing_node_type'
  | 'unknown_edge_target'
  | 'unknown_reference_field'
  | 'invalid_reference_value'
  | 'status_not_allowed'
  | 'invalid_fallback_contact_name'
  | 'unresolved_reference'
  | 'collaborator_cycle'
  | 'subagent_reference_conflict'
  | 'tool_name_collision'
  // Portão 2 do servidor (`AdkService.plan`): Alcance e Agent Control julgados
  // contra o estado da organização (tool que aceita Alcance, lista fechada,
  // integração Agent Control, papel de quem aplica). Nunca emitidos aqui.
  | 'alcance_not_accepted'
  | 'alcance_operador_not_allowed'
  | 'agent_control_area_not_allowed'
  | 'agent_control_not_eligible'
  | 'agent_control_role_insufficient'
  | 'secret_literal'
  | 'pii_in_config'
  | 'internal_id'
  | 'turn_context'
  | 'slug_filename_mismatch'
  | 'package_too_large'
  | 'limits_over_budget'
  | 'ui_adherence'
  | 'prompt_file_outside_repo'
  | 'prompt_file_missing'
  | 'prompt_file_unreadable'
  | 'org_yaml_missing'
  | 'org_environments_missing'
  | 'org_environment_empty'
  // `kind: team` (ADR-290 D4). Emitidos por `validateTeamSpecStructure` e `resolverTime`; o servidor reprova o mesmo.
  | 'duplicate_team_key'
  | 'invalid_team_piece'
  | 'invalid_piece_reference'
  | 'undo_reason_missing'
  | 'released_team_with_em_breve'
  | 'team_without_principal'
  | 'agent_piece_without_member'
  | 'unknown_team_piece'
  | 'unknown_pipeline_stage'
  | 'invalid_team_inheritance'
  // Portão LOCAL da CLI para pacote de time (`adk build`/`adk validate`): o arquivo que uma peça `spec:` aponta. Sem emissor no servidor.
  | 'team_piece_file_missing'
  | 'team_piece_file_outside_package';

export interface SpecIssue {
  code: SpecIssueCode;
  path: string;
  message: string;
}

/** Estado de uma referência depois do import (ADR-107 §3). */
export interface ReferencePending {
  field: string;
  slug: string;
  reason: 'not_found' | 'ambiguous';
}

export interface ActivationInput {
  spec: Pick<AgentSpec, 'slug' | 'definition' | 'collaborators'>;
  /** Pendências herdadas do import — cada uma impede a ativação. */
  pending?: readonly ReferencePending[];
  /** Slug da credencial de modelo resolvida; ausente impede ativar. */
  modelCredentialSlug?: string | null;
  /**
   * Composição JÁ GRAVADA da organização: principal → colaboradores.
   *
   * Só o que está no banco — as arestas que ESTE arquivo vai criar não entram
   * aqui, e nem devem: quem as sobrepõe é o próprio portão, em
   * `compositionEdgesAfterApply`.
   */
  compositionEdges?: Readonly<Record<string, readonly string[]>>;
}

// --- Portão 1 ---------------------------------------------------------------

/**
 * hub#2.6.21.19 (N10) — `mcp` e `app` entram aqui porque o servidor já os
 * aceita e o `adk deploy` precisa ancorar o kind ESPERADO da pasta. Sem eles,
 * `validateSpecStructureAs('app', …)` não compilava e a CLI nunca conseguia
 * despachar um app ou um satélite.
 */
export type SpecKind = 'agent' | 'tool' | 'journey' | 'table' | 'mcp' | 'app' | 'team';
export const SPEC_KINDS: readonly SpecKind[] = [
  'agent',
  'tool',
  'journey',
  'table',
  'mcp',
  'app',
  'team',
];

export type AnySpec = Partial<AgentSpec> | Partial<ToolSpec> | Partial<JourneySpec>;

/** Slug de arquivo/conexão: minúsculo, dígitos e hífen. */
const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Portão 1 — dispatcher por `kind`. Cada tipo de artefato tem o seu validador;
 * o que os três compartilham é o contrato do erro (code/path/message) e a
 * divisão do ADR-107: estrito em ESTRUTURA, permissivo em parâmetro.
 */
export function validateSpecStructure(spec: AnySpec | null | undefined): SpecIssue[] {
  if (!spec || typeof spec !== 'object') {
    return [{ code: 'invalid_document', path: '', message: 'Arquivo vazio ou ilegível.' }];
  }
  const kind = (spec as { kind?: unknown }).kind;
  switch (kind) {
    case 'agent':
      return validateAgentSpecStructure(spec as Partial<AgentSpec>);
    case 'tool':
      return validateToolSpecStructure(spec as Partial<ToolSpec>);
    case 'journey':
      return validateJourneySpecStructure(spec as Partial<JourneySpec>);
    // `kind: app` (ADR-120 §4) reusa o portão de tool: a estrutura do
    // `definition` é a mesma (nome, descrição-contrato, input_schema); o que o
    // app tem a mais — `entryPoints`, `ui.adherence` — é conferido pelo lint de
    // aderência, não pela estrutura.
    case 'app':
      return validateToolSpecStructure(spec as Partial<ToolSpec>);
    // `kind: mcp` (ADR-120 §4 / hub#2.6.21.19) NÃO reusa o portão de tool: o
    // satélite não declara `input_schema` — ele declara `image` por digest,
    // `limits` e `connections`. O portão PROFUNDO (orçamento, allowlist de
    // registry, recusa de destino interno) é do SERVIDOR e é a autoridade;
    // replicá-lo no pacote público criaria duas fontes de verdade que
    // divergiriam na primeira mudança de política. Aqui vale só o que a CLI
    // consegue afirmar sozinha: documento legível, versão de spec e slug.
    case 'mcp':
      return validateMcpSpecStructure(spec as { spec_version?: string; slug?: string });
    // `kind: table` (hub#2.6.21.21, N22) — mesma disciplina do `mcp`: aqui só
    // o que a CLI afirma sozinha. O diff compatível×breaking e o dry-run
    // contra dados REAIS são do servidor, que é quem tem os dados.
    case 'table':
      return validateMcpSpecStructure(spec as { spec_version?: string; slug?: string });
    // `kind: team` (ADR-290): o esquema e as regras do pacote de time vivem em `team-spec.ts`.
    case 'team':
      return validateTeamSpecStructure(spec);
    default:
      return [
        {
          code: 'unknown_kind',
          path: 'kind',
          message: `Tipo de artefato não reconhecido: ${String(kind)}.`,
        },
      ];
  }
}

/**
 * Mesma validação, ancorada num kind ESPERADO — é o que cada rota/comando usa.
 * Um arquivo de jornada mandado para o apply de tool não pode "passar porque é
 * um spec válido": kind conhecido mas diferente é recusado com o nome certo.
 */
export function validateSpecStructureAs(
  esperado: SpecKind,
  spec: AnySpec | null | undefined,
): SpecIssue[] {
  if (!spec || typeof spec !== 'object') {
    return [{ code: 'invalid_document', path: '', message: 'Arquivo vazio ou ilegível.' }];
  }
  const kind = (spec as { kind?: unknown }).kind;
  if (kind !== esperado) {
    if ((SPEC_KINDS as readonly unknown[]).includes(kind)) {
      return [
        {
          code: 'kind_mismatch',
          path: 'kind',
          message: `Este comando aplica "${esperado}"; o arquivo declara kind: ${String(kind)}.`,
        },
      ];
    }
    return [
      {
        code: 'unknown_kind',
        path: 'kind',
        message: `Tipo de artefato não reconhecido: ${String(kind)}.`,
      },
    ];
  }
  return validateSpecStructure(spec);
}

/**
 * Versão do contrato: aceita a janela N/N-1. O hub-v2 comparava com a constante
 * única (`spec.spec_version !== AGENT_SPEC_VERSION`); a lista é a mesma coisa
 * enquanto só existe `v1`, e é o que deixa o pacote e o servidor concordarem no
 * dia em que `v2` nascer — mensagem inalterada.
 */
function specVersionIssue(spec_version: unknown): SpecIssue[] {
  if (typeof spec_version === 'string' && SUPPORTED_SPEC_VERSIONS.includes(spec_version)) return [];
  return [
    {
      code: 'unknown_spec_version',
      path: 'spec_version',
      message: `Versão de especificação não reconhecida: ${String(spec_version)}.`,
    },
  ];
}

export function validateAgentSpecStructure(
  spec: Partial<Omit<AgentSpec, 'tools' | 'tools_remover' | 'agent_control'>> & {
    tools?: unknown;
    tools_remover?: unknown;
    agent_control?: unknown;
  },
): SpecIssue[] {
  const issues: SpecIssue[] = [];

  issues.push(...specVersionIssue(spec.spec_version));

  if (!spec.slug) {
    issues.push({ code: 'missing_slug', path: 'slug', message: 'O agente precisa de um nome.' });
  }

  // Campo sem grupo declarado é recusado no save: a classificação é contrato, e
  // aceitar o desconhecido aqui o faria atravessar a fronteira sem decisão.
  for (const field of Object.keys(spec.definition ?? {})) {
    if (AGENT_FIELD_GROUPS[field] === undefined) {
      issues.push({
        code: 'unclassified_field',
        path: `definition.${field}`,
        message: `Campo não classificado no contrato do agente: ${field}.`,
      });
    }
  }
  issues.push(...marcadorFieldIssues(spec.definition));
  issues.push(...definitionValueIssues(spec.definition));

  issues.push(...duplicateCollaborators(spec.collaborators ?? []));
  issues.push(...toolBindingIssues(spec.tools));
  issues.push(...toolRevocationIssues(spec.tools_remover, spec.tools));
  issues.push(...agentControlIssues(spec.agent_control));

  return issues;
}

/**
 * O marcador de gestão (`managedBy`, `specHash`…) é `state`: escrito só pelo
 * apply. Declará-lo em `definition` é recusado — senão o arquivo declararia a
 * própria procedência e o hash se auto-referenciaria.
 */
function marcadorFieldIssues(definition: unknown): SpecIssue[] {
  if (!definition || typeof definition !== 'object') return [];
  return Object.keys(definition as Record<string, unknown>)
    .filter((campo) => ADK_MARCADOR_FIELDS.includes(campo))
    .map((campo) => ({
      code: 'state_field_not_writable' as const,
      path: `definition.${campo}`,
      message: `Campo do marcador de gestão do ADK não pode ser escrito pelo arquivo: ${campo}.`,
    }));
}

function ehAlcance(valor: unknown): valor is Alcance {
  return typeof valor === 'string' && (ALCANCES as readonly string[]).includes(valor);
}

function umDe(valores: readonly string[]): (valor: unknown) => boolean {
  return (valor) => typeof valor === 'string' && valores.includes(valor);
}

/**
 * Valor dos campos de `definition` cujo domínio é fechado. Mesma régua do
 * portão do hub-v2 (o DTO do agente recusaria o mesmo valor com 400 no meio do
 * apply); o que não está aqui é permissivo em parâmetro, como no ADR-107.
 */
const REGRAS_DE_VALOR: Readonly<
  Record<string, { valido: (valor: unknown) => boolean; esperado: string }>
> = {
  executionPolicy: {
    valido: umDe(['recomendado', 'rapido', 'barato', 'eu-escolho']),
    esperado: 'recomendado, rapido, barato ou eu-escolho',
  },
  executionZdr: { valido: (v) => typeof v === 'boolean', esperado: 'true ou false' },
  modelSource: {
    valido: (v) => v === null || umDe(['simplafy', 'byok'])(v),
    esperado: 'simplafy, byok ou null',
  },
  crmFunctions: {
    valido: (v) => Array.isArray(v) && v.every((f) => typeof f === 'string' && f.length > 0),
    esperado: 'uma lista de ids de função do CRM',
  },
  crmAlcance: { valido: ehAlcance, esperado: 'SO_QUEM_FALA, PARCEIRO ou OPERADOR' },
};

function definitionValueIssues(definition: unknown): SpecIssue[] {
  if (!definition || typeof definition !== 'object') return [];
  const issues: SpecIssue[] = [];
  for (const [campo, valor] of Object.entries(definition as Record<string, unknown>)) {
    const regra = REGRAS_DE_VALOR[campo];
    if (!regra || regra.valido(valor)) continue;
    issues.push({
      code: 'invalid_field_value',
      path: `definition.${campo}`,
      message: `${campo} precisa ser ${regra.esperado}, não ${JSON.stringify(valor)}.`,
    });
  }
  return issues;
}

/**
 * Forma do bloco `agent_control: { areas: { <bloco>: read|write|none } }`.
 * Quais áreas são delegáveis, se a organização tem o Agent Control ligado e o
 * papel de quem aplica são do servidor — aqui só a forma.
 */
function agentControlIssues(bloco: unknown): SpecIssue[] {
  if (bloco === undefined) return [];
  const invalido = (path: string, message: string): SpecIssue => ({
    code: 'invalid_agent_control',
    path,
    message,
  });
  if (!bloco || typeof bloco !== 'object' || Array.isArray(bloco)) {
    return [invalido('agent_control', 'agent_control precisa ser um objeto com `areas`.')];
  }
  const issues: SpecIssue[] = [];
  for (const chave of Object.keys(bloco)) {
    if (chave !== 'areas') {
      issues.push(
        invalido(`agent_control.${chave}`, `Chave desconhecida em agent_control: ${chave}.`),
      );
    }
  }
  const areas = (bloco as Record<string, unknown>).areas;
  if (!areas || typeof areas !== 'object' || Array.isArray(areas)) {
    issues.push(
      invalido('agent_control.areas', 'areas precisa ser um mapa { <área>: read | write | none }.'),
    );
    return issues;
  }
  for (const [area, modo] of Object.entries(areas as Record<string, unknown>)) {
    if (!(AGENT_CONTROL_MODES as readonly unknown[]).includes(modo)) {
      issues.push(
        invalido(
          `agent_control.areas.${area}`,
          `Acesso inválido para ${area}: use read, write ou none.`,
        ),
      );
    }
  }
  return issues;
}

/**
 * hub#2.6.21.11 — forma do bloco `tools:`.
 *
 * Estrito na ESTRUTURA (qual campo endereça o quê, duplicata, nome reservado)
 * e permissivo na EXISTÊNCIA: se a tool existe no registro e a integração na
 * organização é pergunta do Portão 2, que vira pendência.
 */
function toolBindingIssues(tools: unknown): SpecIssue[] {
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) {
    return [
      {
        code: 'invalid_tool_binding',
        path: 'tools',
        message: 'tools precisa ser uma lista de vínculos.',
      },
    ];
  }

  const issues: SpecIssue[] = [];
  const vistos = new Set<string>();

  tools.forEach((bruto, i) => {
    const path = `tools[${i}]`;
    if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) {
      issues.push({ code: 'invalid_tool_binding', path, message: `Vínculo ${i} ilegível.` });
      return;
    }
    const b = bruto as ToolBindingSpec;
    const temTool = typeof b.tool === 'string' && b.tool.length > 0;
    const temIntegration = typeof b.integration === 'string' && b.integration.length > 0;

    if (temTool && b.tool === CRM_AGENT_TOOL_NAME) {
      issues.push({
        code: 'reserved_tool_name',
        path: `${path}.tool`,
        message: `"${CRM_AGENT_TOOL_NAME}" é derivada do toggle de CRM do agente e não pode ser declarada em tools.`,
      });
      vistos.add(String(b.tool));
      return;
    }

    if (temTool === temIntegration) {
      issues.push({
        code: 'invalid_tool_binding',
        path,
        message: 'Cada vínculo declara `tool` OU `integration` — nunca os dois, nunca nenhum.',
      });
      return;
    }

    if (temTool && !TOOL_NAME_REGEX.test(b.tool as string)) {
      issues.push({
        code: 'invalid_tool_binding',
        path: `${path}.tool`,
        message: `Nome de tool inválido: ${String(b.tool)} — snake_case, 3–64 caracteres, iniciando por letra.`,
      });
      return;
    }

    if (
      b.connection !== undefined &&
      (typeof b.connection !== 'string' || !SLUG_REGEX.test(b.connection))
    ) {
      issues.push({
        code: 'invalid_tool_binding',
        path: `${path}.connection`,
        message: `Conexão referenciada por valor que não é slug: ${JSON.stringify(b.connection)}.`,
      });
    }

    if (b.enabled !== undefined && typeof b.enabled !== 'boolean') {
      issues.push({
        code: 'invalid_tool_binding',
        path: `${path}.enabled`,
        message: `enabled precisa ser true ou false, não ${JSON.stringify(b.enabled)}.`,
      });
    }

    // Se a tool aceita Alcance (e qual) é do servidor, que conhece a tool.
    if (b.alcance !== undefined && !ehAlcance(b.alcance)) {
      issues.push({
        code: 'invalid_tool_binding',
        path: `${path}.alcance`,
        message: `alcance precisa ser SO_QUEM_FALA, PARCEIRO ou OPERADOR, não ${JSON.stringify(b.alcance)}.`,
      });
    }

    if (temTool && b.allowed_actions !== undefined) {
      issues.push({
        code: 'invalid_tool_binding',
        path: `${path}.allowed_actions`,
        message:
          'allowed_actions só se aplica a vínculos `integration:` — em `tool:` use mcp_tool_names.',
      });
    }

    if (temIntegration && !(Array.isArray(b.allowed_actions) && b.allowed_actions.length > 0)) {
      issues.push({
        code: 'invalid_tool_binding',
        path: `${path}.allowed_actions`,
        message: `integration: ${String(b.integration)} exige allowed_actions explícito — sem a lista, o agente receberia todas as ações da integração.`,
      });
    }

    for (const lista of ['mcp_tool_names', 'allowed_actions'] as const) {
      const valor = b[lista];
      if (valor === undefined) continue;
      if (!Array.isArray(valor) || valor.some((v) => typeof v !== 'string' || v.length === 0)) {
        issues.push({
          code: 'invalid_tool_binding',
          path: `${path}.${lista}`,
          message: `${lista} precisa ser uma lista de nomes.`,
        });
      }
    }

    const chave = temTool
      ? `tool:${String(b.tool)}`
      : `integration:${toSlug(String(b.integration))}`;
    if (vistos.has(chave)) {
      issues.push({
        code: 'duplicate_tool_binding',
        path,
        message: `Vínculo declarado duas vezes: ${String(b.tool ?? b.integration)}.`,
      });
    }
    vistos.add(chave);
  });

  return issues;
}

/** Linhas que nenhum arquivo apaga: cada uma é derivada de outro controle (toggle, tela de áreas). */
const VINCULOS_RESERVADOS = [CRM_AGENT_TOOL_NAME, JOURNEY_AGENT_TOOL_NAME, AGENT_CONTROL_TOOL_NAME];

/** A mesma chave de identidade de `toolBindingIssues`: integração casa pelo slug do nome. */
function chaveDoVinculo(b: { tool?: unknown; integration?: unknown }): string | null {
  if (typeof b.tool === 'string' && b.tool.length > 0) return `tool:${b.tool}`;
  if (typeof b.integration === 'string' && b.integration.length > 0) {
    return `integration:${toSlug(b.integration)}`;
  }
  return null;
}

/**
 * Forma do bloco `tools_remover:` — a revogação declarada. Espelho de
 * `toolRevocationIssues` do hub-v2, travado pela fixture de contrato.
 *
 * O mesmo nome em `tools:` e em `tools_remover:` é contradição: o arquivo
 * pediria o vínculo e a remoção dele no mesmo apply. A contradição que depende
 * da integração resolvida e a linha gerida por outro arquivo são do servidor.
 */
function toolRevocationIssues(revogacoes: unknown, tools: unknown): SpecIssue[] {
  if (revogacoes === undefined) return [];
  const invalido = (path: string, message: string): SpecIssue => ({
    code: 'invalid_tool_revocation',
    path,
    message,
  });
  if (!Array.isArray(revogacoes)) {
    return [invalido('tools_remover', 'tools_remover precisa ser uma lista de vínculos.')];
  }

  const declarados = new Set(
    (Array.isArray(tools) ? tools : [])
      .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
      .map(chaveDoVinculo)
      .filter((c): c is string => c !== null),
  );
  const issues: SpecIssue[] = [];
  const vistos = new Set<string>();

  revogacoes.forEach((bruto, i) => {
    const path = `tools_remover[${i}]`;
    if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) {
      issues.push(invalido(path, `Item ${i} de tools_remover ilegível.`));
      return;
    }
    const item = bruto as Record<string, unknown>;
    for (const chave of Object.keys(item).filter((k) => k !== 'tool' && k !== 'integration')) {
      issues.push(
        invalido(
          `${path}.${chave}`,
          `Chave desconhecida em tools_remover: ${chave} — o item só declara tool ou integration.`,
        ),
      );
    }
    const temTool = typeof item.tool === 'string' && item.tool.length > 0;
    const temIntegration = typeof item.integration === 'string' && item.integration.length > 0;
    if (temTool === temIntegration) {
      issues.push(
        invalido(path, 'Cada item declara `tool` OU `integration` — nunca os dois, nunca nenhum.'),
      );
      return;
    }
    // `AGENT_CONTROL` em qualquer caixa: o Hub compara em maiúsculas.
    const reservado =
      temTool &&
      (VINCULOS_RESERVADOS.includes(item.tool as string) ||
        (item.tool as string).toUpperCase() === AGENT_CONTROL_TOOL_NAME);
    if (reservado) {
      issues.push({
        code: 'reserved_tool_name',
        path: `${path}.tool`,
        message: `"${String(item.tool)}" é derivada de outro controle do agente e não pode ser removida pelo arquivo.`,
      });
      return;
    }
    if (temTool && !TOOL_NAME_REGEX.test(item.tool as string)) {
      issues.push(
        invalido(
          `${path}.tool`,
          `Nome de tool inválido: ${String(item.tool)} — snake_case, 3–64 caracteres, iniciando por letra.`,
        ),
      );
      return;
    }
    const chave = chaveDoVinculo(item) as string;
    if (vistos.has(chave)) {
      issues.push(
        invalido(path, `Remoção declarada duas vezes: ${String(item.tool ?? item.integration)}.`),
      );
      return;
    }
    vistos.add(chave);
    if (declarados.has(chave)) {
      issues.push({
        code: 'tool_binding_contradiction',
        path,
        message: `${String(item.tool ?? item.integration)} está em tools e em tools_remover — o arquivo pediria o vínculo e a remoção dele no mesmo apply.`,
      });
    }
  });

  return issues;
}

/**
 * Portão 1 de `kind: tool` — o espelho estrutural do contrato do registro
 * (`ToolContract`): o que o Zod recusaria NA GRAVAÇÃO é recusado aqui, antes
 * da ida à rede, com caminho ancorado no arquivo.
 */
/**
 * Estrutura mínima de um servidor MCP satélite. Deliberadamente rasa — ver a
 * nota no `case 'mcp'` do dispatcher: o orçamento, a allowlist de registry por
 * digest e a recusa de destino interno vivem no servidor, que é quem recusa.
 */
export function validateMcpSpecStructure(spec: {
  spec_version?: string;
  slug?: string;
}): SpecIssue[] {
  const issues: SpecIssue[] = [];
  issues.push(...specVersionIssue(spec.spec_version));
  if (!spec.slug) {
    issues.push({
      code: 'missing_slug',
      path: 'slug',
      message: 'O servidor MCP precisa de um slug.',
    });
  } else if (!SLUG_REGEX.test(spec.slug)) {
    issues.push({
      code: 'invalid_slug',
      path: 'slug',
      message: `Slug inválido: "${spec.slug}" — use minúsculas, dígitos e hífen.`,
    });
  }
  return issues;
}

export function validateToolSpecStructure(spec: Partial<ToolSpec>): SpecIssue[] {
  const issues: SpecIssue[] = [];

  issues.push(...specVersionIssue(spec.spec_version));

  if (!spec.slug) {
    issues.push({ code: 'missing_slug', path: 'slug', message: 'A tool precisa de um slug.' });
  } else if (!SLUG_REGEX.test(spec.slug)) {
    issues.push({
      code: 'invalid_slug',
      path: 'slug',
      message: `Slug inválido: "${spec.slug}" — use minúsculas, dígitos e hífen.`,
    });
  }

  const d = spec.definition;
  if (!d || typeof d !== 'object') {
    issues.push({
      code: 'missing_definition',
      path: 'definition',
      message: 'O arquivo não tem o bloco definition.',
    });
    return issues;
  }

  if (typeof d.name !== 'string' || !TOOL_NAME_REGEX.test(d.name)) {
    issues.push({
      code: 'invalid_tool_name',
      path: 'definition.name',
      message: `Nome de tool inválido: ${String(d.name)} — snake_case, 3–64 caracteres, iniciando por letra (regra do registro).`,
    });
  }

  // A descrição É o contrato para o LLM decidir acionar — o registro exige
  // mínimo 20 caracteres na gravação, e o portão espelha para o erro aparecer
  // ancorado no arquivo, não num 500 do apply.
  if (typeof d.description !== 'string' || d.description.trim().length < 20) {
    issues.push({
      code: 'missing_description',
      path: 'definition.description',
      message:
        'A descrição é o contrato para o modelo decidir quando acionar a tool — obrigatória, mínimo 20 caracteres.',
    });
  }

  if (!(TOOL_KINDS as readonly string[]).includes(String(d.kind))) {
    issues.push({
      code: 'unknown_tool_kind',
      path: 'definition.kind',
      message: `Kind interno não reconhecido: ${String(d.kind)} — use ${TOOL_KINDS.join(' | ')}.`,
    });
  }

  // Arquivo de organização só declara tool da própria organização: escopo
  // global é do catálogo da plataforma, nunca de um repositório de cliente.
  if (d.scope !== undefined && d.scope !== 'org') {
    issues.push({
      code: 'invalid_scope',
      path: 'definition.scope',
      message: `Escopo não permitido em arquivo de organização: ${String(d.scope)} — só "org".`,
    });
  }

  if (!JsonSchemaObjeto.safeParse(d.input_schema).success) {
    issues.push({
      code: 'invalid_input_schema',
      path: 'definition.input_schema',
      message: 'input_schema precisa ser um JSON Schema de objeto (type: object, properties).',
    });
  }

  const connections = (spec as { connections?: unknown }).connections;
  if (connections !== undefined) {
    if (!Array.isArray(connections)) {
      issues.push({
        code: 'invalid_connection',
        path: 'connections',
        message: 'connections precisa ser uma lista de slugs.',
      });
    } else {
      connections.forEach((c, i) => {
        if (typeof c !== 'string' || !SLUG_REGEX.test(c)) {
          issues.push({
            code: 'invalid_connection',
            path: `connections.${i}`,
            message: `Conexão referenciada por valor que não é slug: ${JSON.stringify(c)}.`,
          });
        }
      });
    }
  }

  return issues;
}

/**
 * Portão 1 de `kind: journey` — estrito na ESTRUTURA do grafo (identidade dos
 * nós e destino das arestas), permissivo nos parâmetros de cada nó.
 */
export function validateJourneySpecStructure(spec: Partial<JourneySpec>): SpecIssue[] {
  const issues: SpecIssue[] = [];

  issues.push(...specVersionIssue(spec.spec_version));

  if (!spec.slug) {
    issues.push({ code: 'missing_slug', path: 'slug', message: 'A jornada precisa de um slug.' });
  }

  const d = spec.definition;
  if (!d || typeof d !== 'object') {
    issues.push({
      code: 'missing_definition',
      path: 'definition',
      message: 'O arquivo não tem o bloco definition.',
    });
    return issues;
  }

  if (typeof d.name !== 'string' || d.name.trim().length === 0) {
    issues.push({
      code: 'missing_name',
      path: 'definition.name',
      message: 'A jornada precisa de um nome de exibição.',
    });
  }

  issues.push(...fallbackContactNameIssues(d as Record<string, unknown>));

  const trigger = d.trigger as { type?: unknown } | undefined;
  if (
    !trigger ||
    typeof trigger !== 'object' ||
    typeof trigger.type !== 'string' ||
    !trigger.type
  ) {
    issues.push({
      code: 'missing_trigger',
      path: 'definition.trigger',
      message: 'A jornada precisa de um trigger com type declarado.',
    });
  }

  const flow = d.flow;
  if (!Array.isArray(flow) || flow.length === 0) {
    issues.push({
      code: 'missing_flow',
      path: 'definition.flow',
      message: 'A jornada precisa de um flow com ao menos um nó.',
    });
  } else {
    issues.push(...validateFlowGraph(flow as JourneyFlowNode[]));
  }

  // issue#2263 — `references:` do trigger tem a MESMA forma da dos nós do
  // flow: chave desconhecida ou valor vazio/não-string é bloqueio estrutural,
  // nunca passa cru (um id inventado no grafo é pior que recusar o save).
  const trigger2 = d.trigger as { references?: unknown } | undefined;
  issues.push(...validateReferencesBlock(trigger2?.references, 'definition.trigger.references'));

  // Jornada aplicada nunca nasce ativa: ativar é gesto do operador. Recusar no
  // portão (e não silenciosamente rebaixar) diz a quem escreveu o arquivo que a
  // intenção declarada não vai acontecer.
  const status = (spec.overridable as { status?: unknown } | undefined)?.status;
  if (status !== undefined && status !== 'DRAFT' && status !== 'PAUSED') {
    issues.push({
      code: 'status_not_allowed',
      path: 'overridable.status',
      message: `Status não permitido no apply: ${String(status)} — jornada nasce DRAFT ou PAUSED, nunca ativa.`,
    });
  }

  return issues;
}

/**
 * "Como chamar quem não tem nome" (`definition.fallbackContactName`) — mesma régua e mesmas mensagens do portão do
 * Hub, para `adk validate` recusar antes de o arquivo sair da máquina. Ausente não é issue.
 */
function fallbackContactNameIssues(definition: Record<string, unknown>): SpecIssue[] {
  if (!('fallbackContactName' in definition)) return [];
  const valor = definition.fallbackContactName;
  const issue = (message: string): SpecIssue[] => [
    { code: 'invalid_fallback_contact_name', path: 'definition.fallbackContactName', message },
  ];
  if (typeof valor !== 'string') {
    return issue('"Como chamar quem não tem nome" precisa ser um texto, por exemplo: cliente.');
  }
  const aparado = valor.trim();
  if (aparado.length === 0) {
    return issue(
      '"Como chamar quem não tem nome" não pode ficar vazio. Declare a palavra (ex.: cliente) ou tire o campo.',
    );
  }
  if (aparado.length > FALLBACK_CONTACT_NAME_MAX) {
    return issue(
      `"Como chamar quem não tem nome" aceita até ${FALLBACK_CONTACT_NAME_MAX} caracteres (veio com ${aparado.length}).`,
    );
  }
  return [];
}

/** Estrutura do grafo: nós com id/type, ids únicos, arestas para nós declarados. */
function validateFlowGraph(flow: readonly JourneyFlowNode[]): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const ids = new Set<string>();

  flow.forEach((no, i) => {
    if (!no || typeof no !== 'object' || typeof no.id !== 'string' || no.id.length === 0) {
      issues.push({
        code: 'missing_node_id',
        path: `definition.flow.${i}.id`,
        message: `Nó ${i} sem id.`,
      });
      return;
    }
    if (ids.has(no.id)) {
      issues.push({
        code: 'duplicate_node_id',
        path: `definition.flow.${i}.id`,
        message: `Nó declarado duas vezes: ${no.id}.`,
      });
    }
    ids.add(no.id);
    if (typeof no.type !== 'string' || no.type.length === 0) {
      issues.push({
        code: 'missing_node_type',
        path: `definition.flow.${i}.type`,
        message: `Nó ${no.id} sem type.`,
      });
    }
    issues.push(
      ...validateReferencesBlock(
        (no as { references?: unknown }).references,
        `definition.flow.${i}.references`,
        typeof no.id === 'string' ? no.id : undefined,
      ),
    );
  });

  flow.forEach((no, i) => {
    if (!no || typeof no !== 'object' || typeof no.id !== 'string') return;
    for (const aresta of ['next', 'on_true', 'on_false'] as const) {
      const alvo = no[aresta];
      if (alvo === undefined) continue;
      if (typeof alvo !== 'string' || !ids.has(alvo)) {
        issues.push({
          code: 'unknown_edge_target',
          path: `definition.flow.${i}.${aresta}`,
          message: `Aresta de ${no.id} aponta para nó que não existe: ${String(alvo)}.`,
        });
      }
    }
  });

  return issues;
}

/**
 * `references:` (trigger OU nó do flow, issue#2263): chave desconhecida ou
 * valor vazio/não-string é bloqueio — nunca atravessa cru, senão um id
 * inventado entra no grafo. `REFERENCE_FIELD_KIND` é a MESMA allowlist usada
 * na resolução do servidor, reusada aqui de propósito.
 */
function validateReferencesBlock(refs: unknown, path: string, nodeId?: string): SpecIssue[] {
  if (refs === undefined) return [];
  if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) {
    return [
      {
        code: 'invalid_reference_value',
        path,
        message: 'references precisa ser um mapa de campo → nome legível.',
      },
    ];
  }
  const issues: SpecIssue[] = [];
  for (const [campo, valor] of Object.entries(refs as Record<string, unknown>)) {
    // O id do nó vai no FIM do caminho (não substitui o índice): o índice
    // mantém o mesmo formato usado pelas demais checagens estruturais deste
    // arquivo; o id acompanha para quem lê a mensagem localizar o nó.
    const campoPath = nodeId ? `${path}.${campo}.${nodeId}` : `${path}.${campo}`;
    if (REFERENCE_FIELD_KIND[campo] === undefined) {
      issues.push({
        code: 'unknown_reference_field',
        path: campoPath,
        message: `Campo de referência não reconhecido: ${campo}.`,
      });
      continue;
    }
    if (typeof valor !== 'string' || valor.trim().length === 0) {
      issues.push({
        code: 'invalid_reference_value',
        path: campoPath,
        message: `Referência ${campo} precisa de um nome legível não-vazio.`,
      });
    }
  }
  return issues;
}

function duplicateCollaborators(collaborators: readonly CollaboratorSpec[]): SpecIssue[] {
  const vistos = new Set<string>();
  const issues: SpecIssue[] = [];
  collaborators.forEach((c, i) => {
    if (vistos.has(c.agent)) {
      issues.push({
        code: 'duplicate_collaborator',
        path: `collaborators.${i}.agent`,
        message: `Colaborador declarado duas vezes: ${c.agent}.`,
      });
    }
    vistos.add(c.agent);
  });
  return issues;
}

// --- Portão 2 ---------------------------------------------------------------

export function validateActivation(input: ActivationInput): SpecIssue[] {
  const issues: SpecIssue[] = [];

  for (const p of input.pending ?? []) {
    issues.push({
      code: 'unresolved_reference',
      path: `references.${p.field}`,
      message:
        p.reason === 'ambiguous'
          ? `Mais de um recurso chamado "${p.slug}" — escolha qual antes de ativar.`
          : `Não existe um recurso chamado "${p.slug}" nesta organização.`,
    });
  }

  // Credencial de modelo PRÓPRIA é opcional no produto: agente sem ela usa a
  // credencial da plataforma. O que continua bloqueando é a referência
  // DECLARADA e não resolvida, tratada acima.

  // issue#2174 — o laço é procurado no grafo COM as arestas que este arquivo
  // vai criar. Procurá-lo só no grafo já gravado deixava o apply criar o laço
  // que o portão deveria barrar.
  const ciclo = findCompositionCycle(
    toSlug(input.spec.slug ?? ''),
    compositionEdgesAfterApply(input.spec, input.compositionEdges ?? {}),
  );
  if (ciclo) {
    issues.push({
      code: 'collaborator_cycle',
      path: 'collaborators',
      message:
        `Não é possível: a colaboração formaria um laço (${ciclo.join(' → ')}). ` +
        `Um agente não pode acabar delegando para si mesmo, direta ou indiretamente.`,
    });
  }

  return issues;
}

/**
 * O grafo de composição como ele FICA depois de aplicar este arquivo.
 *
 * As arestas de saída do agente do arquivo são SUBSTITUÍDAS pelas declaradas,
 * não somadas: o apply remove do banco o colaborador que o arquivo deixou de
 * declarar, então o conjunto declarado já é o estado final.
 *
 * Normaliza os dois lados com `toSlug` porque as chaves do grafo gravado vêm de
 * `toSlug(agent.name)`, enquanto `spec.slug` e `collaborators[].agent` vêm do
 * arquivo escrito à mão.
 */
export function compositionEdgesAfterApply(
  spec: Pick<AgentSpec, 'slug' | 'collaborators'>,
  persisted: Readonly<Record<string, readonly string[]>>,
): Record<string, string[]> {
  const edges: Record<string, string[]> = {};
  for (const [pai, subs] of Object.entries(persisted)) {
    edges[toSlug(pai)] = subs.map((s) => toSlug(s));
  }
  edges[toSlug(spec.slug ?? '')] = (spec.collaborators ?? []).map((c) => toSlug(c.agent));
  return edges;
}

/**
 * Procura um laço na composição a partir de um agente.
 *
 * Devolve o caminho do laço para a mensagem poder nomear quem fecha o círculo —
 * dizer apenas "há um ciclo" deixa quem configurou procurando no escuro.
 */
export function findCompositionCycle(
  start: string,
  edges: Readonly<Record<string, readonly string[]>>,
): string[] | null {
  const caminho: string[] = [];
  const naPilha = new Set<string>();

  function visitar(no: string): string[] | null {
    if (naPilha.has(no)) return [...caminho.slice(caminho.indexOf(no)), no];
    naPilha.add(no);
    caminho.push(no);
    for (const proximo of edges[no] ?? []) {
      const achado = visitar(proximo);
      if (achado) return achado;
    }
    caminho.pop();
    naPilha.delete(no);
    return null;
  }

  return visitar(start);
}

export function isBlocking(issues: readonly SpecIssue[]): boolean {
  return issues.length > 0;
}
