/**
 * Artefatos declarados num repositório de clientes (`orgs/<org>/<pasta>/*.yaml`).
 *
 * A ordem das pastas É a ordem de aplicação: tool antes de agente (um agente
 * pode referenciar a tool que este mesmo apply cria) e jornada por último (pode
 * acionar agente e tool).
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { scanLeaks, type SpecIssue } from '@simpla.fy/adk-contract';
import { orgIdDaPasta } from './org-config.js';

export interface PastaConhecida {
  pasta: string;
  kind: 'tool' | 'agent' | 'journey' | 'table' | 'mcp' | 'app';
  /** Segmento da rota da API do Hub. */
  rota: string;
}

/**
 * A ORDEM é a de aplicação do `deploy` — e é dependência, não estética:
 * o agente REFERENCIA tool e servidor MCP, e a jornada referencia o agente.
 * Aplicar fora desta ordem gera pendência de referência (hub#2.6.21.16, N2)
 * que some sozinha no reapply — ruído evitável.
 *
 * `mcp` e `app` entram por hub#2.6.21.19 (N10): o servidor já aceita os dois
 * kinds e o `adk init app` já cria o esqueleto, mas sem estas linhas o
 * `deploy` nunca ENCONTRAVA o arquivo — o app ficava no disco do autor.
 */
export const PASTAS: readonly PastaConhecida[] = [
  { pasta: 'tools', kind: 'tool', rota: 'tools' },
  { pasta: 'tabelas', kind: 'table', rota: 'tables' },
  { pasta: 'mcp', kind: 'mcp', rota: 'mcp' },
  { pasta: 'apps', kind: 'app', rota: 'apps' },
  { pasta: 'agentes', kind: 'agent', rota: 'agents' },
  { pasta: 'jornadas', kind: 'journey', rota: 'journeys' },
];

export interface Artefato extends PastaConhecida {
  org: string;
  arquivo: string;
  caminho: string;
  yaml: string;
  /** Raiz do repositório de clientes (a pasta que contém `orgs/`). */
  raiz: string;
  /**
   * issue#2500 — diretório do PACOTE, quando o artefato veio de
   * `<pasta>/<slug>/manifest.yaml`. É daqui que o `deploy` tira os arquivos do
   * bundle de uma tool `runtime: script`; `undefined` para o `.yaml` solto, que
   * não tem pacote nenhum e onde inventar um diretório seria mentira.
   */
  dirPacote?: string;
}

export function listarArtefatos(raiz: string): Artefato[] {
  const orgsDir = join(raiz, 'orgs');
  let orgs: string[];
  try {
    orgs = readdirSync(orgsDir).filter((o) => statSync(join(orgsDir, o)).isDirectory());
  } catch {
    return [];
  }
  const encontrados: Artefato[] = [];
  for (const { pasta, kind, rota } of PASTAS) {
    for (const org of orgs) {
      const dir = join(orgsDir, org, pasta);
      let entradas: string[] = [];
      try {
        entradas = readdirSync(dir).sort();
      } catch {
        continue;
      }
      for (const entrada of entradas) {
        const alvo = join(dir, entrada);

        // Formato 1 — `.yaml` SOLTO: o artefato é o arquivo, sem pacote.
        if (/\.ya?ml$/.test(entrada)) {
          encontrados.push({
            org,
            pasta,
            kind,
            rota,
            arquivo: entrada,
            caminho: alvo,
            raiz,
            yaml: readFileSync(alvo, 'utf8'),
          });
          continue;
        }

        // Formato 2 (issue#2500) — PACOTE: `<slug>/manifest.yaml`. É o que o
        // `adk init tool`/`adk init app` produzem, e tem de ser pasta porque a
        // tool de script carrega pyproject/uv.lock/handler/tests junto. Sem
        // este ramo o `deploy` não encontrava nada e culpava o `org.yaml`.
        let ehPasta = false;
        try {
          ehPasta = statSync(alvo).isDirectory();
        } catch {
          continue;
        }
        if (!ehPasta) continue;

        const manifesto = join(alvo, 'manifest.yaml');
        let yaml: string;
        try {
          yaml = readFileSync(manifesto, 'utf8');
        } catch {
          // Pasta sem manifesto não é artefato — é rascunho do autor. Silêncio
          // aqui é deliberado: promover a artefato o que não se declara como um
          // faria o deploy subir lixo.
          continue;
        }
        encontrados.push({
          org,
          pasta,
          kind,
          rota,
          arquivo: `${entrada}/manifest.yaml`,
          caminho: manifesto,
          raiz,
          yaml,
          dirPacote: alvo,
        });
      }
    }
  }
  return encontrados;
}

/** Artefatos das pastas cujo `org.yaml` declara ESTE id no ambiente. */
export function artefatosDaOrg(raiz: string, orgId: string, ambiente: string): Artefato[] {
  const artefatos = listarArtefatos(raiz);
  const pastasDoAlvo = new Set(
    [...new Set(artefatos.map((a) => a.org))].filter(
      (p) => orgIdDaPasta(raiz, p, ambiente) === orgId,
    ),
  );
  return artefatos.filter((a) => pastasDoAlvo.has(a.org));
}

/**
 * Conteúdo do arquivo apontado por `prompt_file:` (relativo ao YAML).
 *
 * O prompt viaja no corpo junto do YAML cru: o Hub não tem o filesystem do
 * repositório de clientes, então é a CLI que materializa a referência. Arquivo
 * declarado e ilegível é erro DESTE artefato — aplicar o agente sem instrução,
 * em silêncio, seria pior.
 *
 * Duas guardas, porque este é o ÚNICO conteúdo do corpo que não vem do YAML
 * versionado:
 *  1. confinamento — um `prompt_file: ../../../.config/.../credentials.json`
 *     faria a CLI ler um arquivo qualquer do disco do operador e publicá-lo
 *     como prompt do agente;
 *  2. vazamento — o prompt passa pelo mesmo `scanLeaks` do resto do artefato,
 *     senão colar um segredo no prompt seria a rota de fuga do portão.
 */
export function promptDe(artefato: Artefato): { prompt?: string; issues: SpecIssue[] } {
  const declarado = artefato.yaml.match(/^prompt_file:\s*["']?([^"'\n]+?)["']?\s*$/m)?.[1];
  if (!declarado) return { issues: [] };

  const caminho = resolve(dirname(artefato.caminho), declarado);

  // `realpathSync` resolve symlink ANTES do `relative()`: um `prompt_file`
  // dentro da raiz que é symlink para fora não pode passar só porque o nome
  // do link resolve dentro (rodada 2, finding #1). Se o alvo nem existe
  // (symlink quebrado) é issue DESTE artefato, código estável, sem o caminho
  // absoluto do host na mensagem — não aborta os demais (rodada 3, item 4).
  // Toda falha aqui é issue DESTE artefato, com código estável e SÓ o valor
  // declarado no YAML na mensagem — nunca o caminho absoluto do host.
  const issue = (code: SpecIssue['code'], message: string) => ({
    issues: [{ code, path: 'prompt_file', message }],
  });

  let caminhoReal: string;
  let raizReal: string;
  try {
    caminhoReal = realpathSync(caminho);
    raizReal = realpathSync(artefato.raiz);
  } catch {
    return issue(
      'prompt_file_missing',
      `prompt_file "${declarado}" aponta para um arquivo que não existe`,
    );
  }

  const dentro = relative(raizReal, caminhoReal);
  if (dentro.startsWith('..') || isAbsolute(dentro)) {
    return issue(
      'prompt_file_outside_repo',
      `prompt_file "${declarado}" resolve para fora do repositório de clientes — o prompt tem de ser um arquivo versionado junto do agente`,
    );
  }

  let prompt: string;
  try {
    prompt = readFileSync(caminhoReal, 'utf8');
  } catch {
    // Alvo existe mas não é legível (diretório, EPERM): não aborta o lote nem
    // vaza o caminho do host em `hub_error`.
    return issue(
      'prompt_file_unreadable',
      `prompt_file "${declarado}" existe mas não pôde ser lido como arquivo de texto`,
    );
  }
  return {
    prompt,
    issues: scanLeaks(prompt, { filename: dentro, checkSlug: false }),
  };
}

/** Pastas de organização (`orgs/<org>/`), com ou sem artefato dentro. */
export function listarOrgs(raiz: string): string[] {
  try {
    return readdirSync(join(raiz, 'orgs'))
      .filter((o) => statSync(join(raiz, 'orgs', o)).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

/**
 * Os outros `*.yaml` de uma pasta de organização — `vinculos/` hoje, o que o
 * cliente inventar amanhã. Não são spec (não passam pelo portão de estrutura),
 * mas passam pelo MESMO portão de vazamento: o `validar.mjs` já cobria
 * `vinculos/`, e segredo num arquivo versionado é segredo vazado
 * independentemente de o Hub saber lê-lo.
 *
 * Fora: `prompts/` e `roteiros/` (texto do agente, não configuração) e o
 * próprio `org.yaml` — ele é a amarração de tenant, e os ids de organização que
 * ele carrega por natureza acusariam `internal_id` em toda execução.
 */
const PASTAS_DE_TEXTO = ['prompts', 'roteiros'];

export interface YamlExtra {
  org: string;
  rel: string;
  texto: string;
}

export function listarYamlsExtras(raiz: string): YamlExtra[] {
  const encontrados: YamlExtra[] = [];
  const pastasDeSpec = PASTAS.map((p) => p.pasta);

  for (const org of listarOrgs(raiz)) {
    const base = join(raiz, 'orgs', org);
    const pilha: string[] = [''];
    while (pilha.length > 0) {
      const relDir = pilha.pop() as string;
      let entradas: string[];
      try {
        entradas = readdirSync(join(base, relDir)).sort();
      } catch {
        continue;
      }
      for (const entrada of entradas) {
        const rel = relDir ? `${relDir}/${entrada}` : entrada;
        const caminho = join(base, rel);
        if (statSync(caminho).isDirectory()) {
          if (relDir === '' && [...pastasDeSpec, ...PASTAS_DE_TEXTO].includes(entrada)) continue;
          pilha.push(rel);
          continue;
        }
        if (!/\.ya?ml$/.test(entrada) || rel === 'org.yaml') continue;
        encontrados.push({
          org,
          rel: `orgs/${org}/${rel}`,
          texto: readFileSync(caminho, 'utf8'),
        });
      }
    }
  }
  return encontrados;
}
