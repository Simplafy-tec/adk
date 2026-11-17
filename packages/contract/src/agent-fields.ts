/**
 * ADK — classificação dos campos do agente.
 *
 * Porte fiel de `apps/api/src/adk/agent-fields.ts` (hub-v2, origin/staging).
 * A classificação é CONTRATO, não detalhe de implementação: ela decide o que
 * atravessa a fronteira do produto num arquivo declarativo e o que fica.
 *
 * As duas tabelas são travadas pela mesma fixture
 * (`test/fixtures/agent-contract.json`, replicada verbatim do hub-v2): campo
 * novo de um lado sem o outro reprova o teste do lado que ficou para trás.
 */

export type AgentFieldGroup =
  /** Vai para o arquivo e fica travado na UI quando a origem é ADK. */
  | 'definition'
  /** Identidade e carimbos do banco — nunca atravessa a fronteira. */
  | 'state'
  /** Vai para o arquivo, mas a edição na UI sobrevive ao próximo import. */
  | 'overridable'
  /** Definição exportada por slug legível, nunca pelo cuid (ADR-107 §3). */
  | 'reference'
  /** Coluna de cliente em aposentadoria — não entra no arquivo. */
  | 'retired';

export const AGENT_FIELD_GROUPS: Readonly<Record<string, AgentFieldGroup>> = {
  // --- state ---------------------------------------------------------------
  id: 'state',
  orgId: 'state',
  langgraphAssistantId: 'state',
  createdById: 'state',
  createdAt: 'state',
  updatedAt: 'state',
  // issue#3571 (hub-v2) — versão de edição (If-Match): trocada por todo salvar do agente; estado, nunca vai para o arquivo.
  editedAt: 'state',
  // Hub#2.7.23.3 — rascunho intocado do «Novo agente» (não conta no limite do plano até a 1ª gravação): estado do servidor,
  // nunca definido por arquivo ADK nem lido de snapshot.
  rascunhoIntocado: 'state',
  // Hub#11.2.2.5 (hub-v2 #5840) — credencial BYOK da memória permanente: id da org, nunca vai para o arquivo.
  contactMemoryModelCredentialId: 'state',
  // Marcador de gestão pelo ADK: metadado do provisionamento, nunca definição
  // (senão o arquivo declararia a própria procedência e o hash se
  // auto-referenciaria).
  managedBy: 'state',
  sourceRef: 'state',
  specHash: 'state',
  lockedFields: 'state',
  managedAt: 'state',

  // --- reference (cuid no banco, slug no arquivo) --------------------------
  pipelineId: 'reference',
  channelId: 'reference',
  modelCredentialId: 'reference',
  accessOnboardingAgentId: 'reference',
  accessListIntegrationId: 'reference',
  accessListSourceId: 'reference',

  // --- overridable ---------------------------------------------------------
  // Ligar/desligar um agente é operação, não definição: quem opera precisa
  // parar o atendimento sem editar o arquivo e sem perder a alteração no
  // próximo import.
  status: 'overridable',
  // Upload de avatar e endereço de e-mail são provisionados por ambiente.
  avatarUrl: 'overridable',
  emailResourceAddress: 'overridable',

  // --- retired -------------------------------------------------------------
  uniflexCadernoEnabled: 'retired',

  // --- definition ----------------------------------------------------------
  name: 'definition',
  description: 'definition',
  icon: 'definition',
  model: 'definition',
  reserveModel: 'definition',
  reserveEnabled: 'definition',
  reserveProvider: 'definition',
  // Origem do custo (Gerenciado × BYOK) anda junto com a credencial e o modelo.
  modelSource: 'definition',
  provider: 'definition',
  // Quem executa a conversa (política, fornecedor e privacidade).
  executionPolicy: 'definition',
  executionProvider: 'definition',
  executionZdr: 'definition',
  systemPrompt: 'definition',
  temperature: 'definition',
  topP: 'definition',
  reasoningEffort: 'definition',
  topK: 'definition',
  maxTokens: 'definition',
  inputBuffer: 'definition',
  // TK-173 (hub-v2 #6401) — Buffer: juntar o que chega enquanto o agente responde.
  mergePendingMessages: 'definition',
  outputDelay: 'definition',
  limiteChamadasPorTurno: 'definition',
  travaLacoAtiva: 'definition',
  repeticoesParaParar: 'definition',
  memoryMax: 'definition',
  memoryTtlDays: 'definition',
  memoryEnabled: 'definition',
  memoryMode: 'definition',
  memoryResetTools: 'definition',
  memoryMessageTimestamps: 'definition',
  // hub-v2 #5816, #5878 e #5943 — poda de tool results, poda de tool-calls antigos e teto em tokens do histórico.
  memoryPruneToolResults: 'definition',
  memoryTrimOldToolCalls: 'definition',
  memoryMaxTokens: 'definition',
  allowImage: 'definition',
  allowDoc: 'definition',
  allowAudio: 'definition',
  smartFilesEnabled: 'definition',
  contactSummaryInContext: 'definition',
  // Hub#11.2.2.5 (hub-v2 #5840) — memória permanente: tipo, registro e modelo próprio da extração.
  contactMemoryRole: 'definition',
  contactMemoryWriteMode: 'definition',
  contactMemoryModel: 'definition',
  contactMemoryModelSource: 'definition',
  audioReply: 'definition',
  ttsProvider: 'definition',
  ttsVoice: 'definition',
  ttsInstruction: 'definition',
  mediaConfig: 'definition',
  summarizationConfig: 'definition',
  // Hub#2.4.8.1 (ADR-257 D6, hub-v2) — Deep Thinking do agente (seção 10 do editor); NULL = desligado.
  deepThinking: 'definition',
  analysisModel: 'definition',
  capabilities: 'definition',
  ragCollection: 'definition',
  ragCollections: 'definition',
  ragThreshold: 'definition',
  ragLimit: 'definition',
  // hub-v2 #6225 — busca na fala original do contato (padrão ligado).
  ragBuscarFalaOriginal: 'definition',
  // Hub#4.3.11.8 (hub-v2 #6260) — Perguntas sem resposta.
  registrarLacunas: 'definition',
  // hub-v2 #6234 — campos do negócio escolhidos pelo agente chegam no turno.
  crmCamposNoTurno: 'definition',
  crmEnabled: 'definition',
  crmPerms: 'definition',
  crmFunctions: 'definition',
  // Campo virtual (ver AGENT_VIRTUAL_FIELDS): o Alcance da tool de CRM.
  crmAlcance: 'definition',
  autoCreateContact: 'definition',
  isSubAgent: 'definition',
  toolTemplates: 'definition',
  behaviors: 'definition',
  accessMode: 'definition',
  accessRejectionAction: 'definition',
  accessRejectionMessage: 'definition',
  accessListSourceType: 'definition',
  accessListPhoneFieldIds: 'definition',
};

/**
 * Campos classificados que NÃO são coluna do model `Agent`. `crmAlcance` mora
 * na sentinela de CRM (`AgentTool(__crm_native_tools__).config.alcance`) e
 * entra pelo mesmo campo do PATCH do agente. A exceção é nomeada: qualquer
 * outro campo fora do schema continua reprovando a paridade no hub-v2.
 */
export const AGENT_VIRTUAL_FIELDS: readonly string[] = ['crmAlcance'];

/**
 * Nomes do marcador de gestão do ADK (os mesmos nos 3 kinds). Classificados
 * como `state` acima; o portão 1 os recusa em `definition` com
 * `state_field_not_writable`.
 */
export const ADK_MARCADOR_FIELDS: readonly string[] = [
  'managedBy',
  'sourceRef',
  'specHash',
  'lockedFields',
  'managedAt',
];

/** Grupos cujos campos atravessam a fronteira para o arquivo declarativo. */
const EXPORTED_GROUPS: ReadonlySet<AgentFieldGroup> = new Set<AgentFieldGroup>([
  'definition',
  'overridable',
  'reference',
]);

export function isExportedField(field: string): boolean {
  const group = AGENT_FIELD_GROUPS[field];
  return group !== undefined && EXPORTED_GROUPS.has(group);
}

export function fieldsInGroup(group: AgentFieldGroup): string[] {
  return Object.keys(AGENT_FIELD_GROUPS)
    .filter((f) => AGENT_FIELD_GROUPS[f] === group)
    .sort();
}

/**
 * Campos do modelo que não têm grupo declarado.
 *
 * Recebe a lista de campos vinda do DMMF para manter esta unidade pura — quem
 * chama decide de onde vem a verdade do schema.
 */
export function unclassifiedFields(modelFields: readonly string[]): string[] {
  return modelFields.filter((f) => AGENT_FIELD_GROUPS[f] === undefined).sort();
}

/** Campos classificados que não existem mais no modelo (sedimento). */
export function staleClassifications(modelFields: readonly string[]): string[] {
  const known = new Set(modelFields);
  return Object.keys(AGENT_FIELD_GROUPS)
    .filter((f) => !known.has(f))
    .sort();
}
