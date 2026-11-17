/**
 * Identidade da pasta de organização por ambiente (`orgs/<pasta>/org.yaml`).
 *
 * Sem esta amarração, `--org <id>` aplicaria os artefatos de TODAS as pastas na
 * organização informada — a configuração de um cliente entrando na conta de
 * outro. Pasta sem `org.yaml` fica de fora por omissão: o silêncio nega.
 *
 * Parseado com `yaml` (a CLI antiga usava regex): comentário no fim da linha e
 * indentação de 4 espaços são YAML válido e quebravam o regex em silêncio — o
 * ambiente "não existia" e a pasta era pulada sem aviso.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpecIssue } from '@simpla.fy/adk-contract';
import { parse } from 'yaml';

export function orgIdDaPasta(raiz: string, pasta: string, ambiente: string): string | null {
  let texto: string;
  try {
    texto = readFileSync(join(raiz, 'orgs', pasta, 'org.yaml'), 'utf8');
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = parse(texto);
  } catch {
    return null;
  }
  const environments = (doc as { environments?: Record<string, unknown> } | null)?.environments;
  const id = environments?.[ambiente];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * A amarração de tenant da pasta, com os códigos estáveis do contrato — porte
 * das três checagens de `org.yaml` do `scripts/validar.mjs` do simplafy-clientes.
 *
 * Pasta sem identidade declarada não é detalhe de formulário: é o arquivo que
 * impede `--org <id>` de subir a configuração de um cliente na conta de outro.
 */
export function checarOrgYaml(raiz: string, pasta: string): SpecIssue[] {
  const caminho = join(raiz, 'orgs', pasta, 'org.yaml');
  let texto: string;
  try {
    texto = readFileSync(caminho, 'utf8');
  } catch {
    return [
      {
        code: 'org_yaml_missing',
        path: `orgs/${pasta}`,
        message: 'sem org.yaml — pasta sem identidade declarada não sobe para tenant nenhum',
      },
    ];
  }

  let doc: unknown;
  try {
    doc = parse(texto);
  } catch {
    return [
      {
        code: 'org_environments_missing',
        path: `orgs/${pasta}/org.yaml`,
        message: 'org.yaml não é YAML válido — sem bloco "environments" legível',
      },
    ];
  }

  const environments = (doc as { environments?: unknown } | null)?.environments;
  if (environments === undefined || environments === null) {
    // `environments:` vazio parseia como null: é bloco declarado sem nenhum
    // ambiente, e o validar.mjs já separava os dois casos.
    const declarado = /^environments:/m.test(texto);
    return [
      declarado
        ? {
            code: 'org_environment_empty',
            path: `orgs/${pasta}/org.yaml`,
            message: 'nenhum ambiente com identificador preenchido',
          }
        : {
            code: 'org_environments_missing',
            path: `orgs/${pasta}/org.yaml`,
            message: 'sem bloco "environments"',
          },
    ];
  }

  const preenchidos = Object.values(environments as Record<string, unknown>).filter(
    (v) => typeof v === 'string' && v.trim().length > 0,
  );
  if (preenchidos.length === 0) {
    return [
      {
        code: 'org_environment_empty',
        path: `orgs/${pasta}/org.yaml`,
        message: 'nenhum ambiente com identificador preenchido',
      },
    ];
  }
  return [];
}
