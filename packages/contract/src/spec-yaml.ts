/**
 * ADK — serialização do spec em YAML.
 *
 * Generalização de `apps/api/src/adk/agent-yaml.ts` (hub-v2, origin/staging)
 * de agent-only para os três kinds, com a MESMA `KEY_ORDER`: o formato é o
 * aprovado no ADR-107 §6 D2 e um diff de configuração precisa ser legível.
 *
 * Camada fina de propósito: aqui só se decide COMO o objeto vira texto. O que
 * atravessa a fronteira é decidido em `agent-spec.ts`; o que é válido, nos
 * portões.
 */

import { parse, stringify } from 'yaml';
import type { AnySpec } from './spec-gates.js';

export type ParsedSpec = AnySpec & { prompt_file?: string };

/** Ordem estável das chaves — diff de configuração precisa ser legível. */
export const KEY_ORDER = [
  'spec_version',
  'kind',
  'slug',
  'style',
  'definition',
  'prompt_file',
  'overridable',
  'references',
  'collaborators',
];

export function serializeSpecYaml(spec: Record<string, unknown>): string {
  return stringify(spec, {
    // Sem ordenação estável, reordenar uma chave produz diff onde nada mudou —
    // e revisão de configuração que mostra ruído deixa de ser lida.
    sortMapEntries: (a, b) => {
      const ia = KEY_ORDER.indexOf(String(a.key));
      const ib = KEY_ORDER.indexOf(String(b.key));
      if (ia === -1 && ib === -1) return String(a.key).localeCompare(String(b.key));
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    },
    lineWidth: 90,
  });
}

export function parseSpecYaml(text: string): ParsedSpec {
  const parsed: unknown = parse(text);
  if (parsed === null || typeof parsed !== 'object') {
    // Arquivo vazio ou escalar não é documento de spec. Devolver um objeto
    // vazio deixa o portão 1 reportar a falta de `kind` com caminho ancorado,
    // em vez de estourar uma exceção sem endereço.
    return {};
  }
  return parsed as ParsedSpec;
}
