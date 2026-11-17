/**
 * issue#2500 — monta o pacote de uma tool `runtime: script` para o `apply`.
 *
 * O servidor sempre RECONFERE o hash (`bundleHashOf` em
 * `apps/api/src/adk/tool-bundle-hash.ts`), então a canonicalização daqui tem de
 * ser byte a byte a mesma do Hub: chaves ordenadas recursivamente, `files` e
 * `lock` como as duas chaves de topo. Divergir aqui = apply recusado com
 * `bundle_hash_mismatch` — falha segura, mas falha.
 *
 * O `uv.lock` viaja em campo PRÓPRIO, fora de `files`: é assim que o contrato
 * do Hub o declara, e é o que o worker usa para hidratar o ambiente.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { listarArquivos, lerTexto } from './pacote.js';

export interface Bundle {
  files: Record<string, string>;
  lock: string;
  hash: string;
}

/**
 * Serialização canônica — espelho de `apps/api/src/common/canonical-json.ts`.
 * Mantida aqui (e não importada do contrato) porque o pacote `adk-contract` não
 * a exporta hoje; se um dia exportar, esta cópia deve morrer.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function bundleHashOf(files: Record<string, string>, lock: string): string {
  return createHash('sha256').update(canonicalJson({ files, lock })).digest('hex');
}

/**
 * Espelho do allowlist do servidor (`tool-bundle-hash.ts::caminhoValido`).
 * Precisa ser o MESMO conjunto: o que o servidor recusa aqui vira
 * `invalid_bundle_path` só depois da viagem, e o autor não tem como adivinhar.
 * Foi o que aconteceu com `.pytest_cache/`, que o `adk test` cria e a varredura
 * do build não ignora.
 */
const PREFIXOS_PERMITIDOS = ['tools/', 'tests/', 'dev/'];
const ARQUIVOS_PERMITIDOS = new Set([
  'pyproject.toml',
  'uv.lock',
  'manifest.yaml',
  'README.md',
  '.python-version',
  '.gitignore',
]);

export function caminhoDoPacote(rel: string): boolean {
  if (ARQUIVOS_PERMITIDOS.has(rel)) return true;
  return PREFIXOS_PERMITIDOS.some((p) => rel.startsWith(p));
}

export function montarBundle(dirPacote: string): Bundle {
  let lock: string;
  try {
    lock = readFileSync(join(dirPacote, 'uv.lock'), 'utf8');
  } catch {
    throw new Error(
      `Pacote sem uv.lock em ${dirPacote} — rode \`adk build\` antes do deploy. ` +
        'Sem o lock o worker não tem como hidratar o ambiente de execução.',
    );
  }

  const files: Record<string, string> = {};
  for (const arquivo of listarArquivos(dirPacote)) {
    // O lock vai em campo próprio; duplicá-lo em `files` mudaria o hash em
    // relação ao que o servidor calcula a partir do contrato.
    if (arquivo.rel === 'uv.lock') continue;
    // Binário não entra: o contrato é `Record<caminho, string>` e o scanner de
    // vazamento do servidor lê tudo como texto.
    if (!arquivo.texto) continue;
    // Só o que o servidor aceita — ver `caminhoDoPacote`.
    if (!caminhoDoPacote(arquivo.rel)) continue;
    files[arquivo.rel] = lerTexto(arquivo);
  }

  return { files, lock, hash: bundleHashOf(files, lock) };
}

/**
 * Declara `hash` e `lock` no spec que vai ao Hub, a partir do pacote real.
 *
 * O Hub confere `validateBundle(bundle, spec.definition.hash)` — o pacote viaja
 * no corpo, mas o hash é declarado no spec. Fazer o autor colar o `uv.lock`
 * dentro do manifest.yaml na mão convidaria à divergência: o lock muda a cada
 * `uv lock`, o hash a cada linha de código, e um hash velho no arquivo faria o
 * apply recusar sem explicar. Quem sabe o conteúdo é o disco.
 *
 * Reescreve APENAS o YAML que vai pelo fio — o arquivo do autor não é tocado.
 * Comentários se perdem nessa serialização, o que é irrelevante para o
 * transporte e não afeta o `specHash` (calculado sobre a estrutura).
 */
export function injetarPacoteNoSpec(yaml: string, bundle: Bundle): string {
  const doc = parseYaml(yaml) as { definition?: Record<string, unknown> } | null;
  if (!doc || typeof doc !== 'object' || !doc.definition) return yaml;
  doc.definition.hash = bundle.hash;
  doc.definition.lock = bundle.lock;
  return stringifyYaml(doc);
}
