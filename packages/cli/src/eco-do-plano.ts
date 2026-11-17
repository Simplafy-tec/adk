/**
 * Eco dos campos de Alcance, Agent Control e revogação de vínculo no plano do agente.
 *
 * Um Hub anterior a esses campos ignora `agent_control`, `tools[].alcance` e
 * `definition.crmAlcance` em silêncio: o plano sai limpo e o apply diz
 * "aplicado" sem ter gravado nada. O Hub que os entende devolve um eco no
 * plano (`agentControl`, `toolBindings[i].alcance`, `crmAlcance`), inclusive
 * quando nada muda — a ausência do eco é o sinal de que o destino não sabe o
 * que fazer com o campo, e a CLI recusa em vez de fingir que aplicou.
 */

import { parseSpecYaml } from '@simpla.fy/adk-contract';
import type { Plano } from './hub.js';

export type CampoComEco = 'agent_control' | 'alcance' | 'crmAlcance' | 'tools_remover';

interface AgenteLido {
  kind?: unknown;
  definition?: Record<string, unknown>;
  agent_control?: unknown;
  tools?: { tool?: unknown; integration?: unknown; alcance?: unknown }[];
  tools_remover?: unknown;
}

function lerAgente(yaml: string): AgenteLido | null {
  const spec = parseSpecYaml(yaml) as AgenteLido | null;
  return spec && typeof spec === 'object' && spec.kind === 'agent' ? spec : null;
}

/** Campos com eco que o arquivo declara — os que exigem um Hub que os entenda. */
export function camposComEcoDeclarados(yaml: string): CampoComEco[] {
  const spec = lerAgente(yaml);
  if (!spec) return [];
  const campos: CampoComEco[] = [];
  if (spec.agent_control !== undefined) campos.push('agent_control');
  if (Array.isArray(spec.tools) && spec.tools.some((b) => b?.alcance !== undefined)) {
    campos.push('alcance');
  }
  if (spec.definition?.crmAlcance !== undefined) campos.push('crmAlcance');
  // Um Hub sem a revogação ignora a chave e responde "sem alteração": o
  // vínculo continuaria concedendo a tool com o plano dizendo que está tudo certo.
  if (spec.tools_remover !== undefined) campos.push('tools_remover');
  return campos;
}

/**
 * Campos declarados que o plano NÃO ecoou. Plano bloqueado não é julgado (o
 * Hub nem chega a planejar os campos). Vínculo que ficou pendente não vira
 * linha de `toolBindings`, então o Alcance só é cobrado quando algum vínculo
 * que o declara foi de fato resolvido.
 */
export function camposSemEco(yaml: string, plano: Plano): CampoComEco[] {
  if ((plano.blocking ?? []).length > 0) return [];
  const spec = lerAgente(yaml);
  if (!spec) return [];
  const faltando: CampoComEco[] = [];
  for (const campo of camposComEcoDeclarados(yaml)) {
    if (campo === 'agent_control' && plano.agentControl === undefined) faltando.push(campo);
    if (campo === 'crmAlcance' && plano.crmAlcance === undefined) faltando.push(campo);
    if (campo === 'alcance' && alcanceSemEco(spec, plano)) faltando.push(campo);
    if (campo === 'tools_remover' && plano.toolRevocations === undefined) faltando.push(campo);
  }
  return faltando;
}

function alcanceSemEco(spec: AgenteLido, plano: Plano): boolean {
  const vinculos = plano.toolBindings ?? [];
  if (vinculos.some((b) => b.alcance !== undefined)) return false;
  const pendentes = new Set((plano.pending ?? []).map((p) => p.slug));
  return (spec.tools ?? []).some((b) => {
    if (b?.alcance === undefined) return false;
    const declarado = typeof b.tool === 'string' ? b.tool : b.integration;
    return typeof declarado === 'string' && !pendentes.has(declarado);
  });
}

export function mensagemSemSuporte(campo: CampoComEco): string {
  return `Hub sem suporte a ${campo}: este Hub ignoraria o campo e nada seria gravado. Atualize o Hub antes de aplicar este arquivo.`;
}
