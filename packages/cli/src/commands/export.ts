/**
 * `adk export` — traz do Hub, na forma declarativa, o que já existe na
 * organização (issue#2773).
 *
 * É a porta de entrada de todo cliente que já está no ar: sem ele, adotar uma
 * organização existente significa redigitar à mão o que o Hub já sabe. O
 * README do `simplafy-clientes` documenta o comando desde sempre — e ele não
 * existia, o que é documentação descrevendo funcionalidade ausente.
 *
 * Contrato do README, respeitado aqui:
 *  - a pasta é encontrada pelo `environments.<ambiente>` do `org.yaml`;
 *  - escreve POR CIMA dos arquivos daquela org (o diff do git é a revisão);
 *  - PRESERVA o que não tem par no Hub — nada é apagado, inclusive pastas que
 *    não são kind do ADK (`roteiros/`);
 *  - campo com identificador interno, segredo ou PII não vem: sai como
 *    comentário `# omitido:` no topo do arquivo.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { listarOrgs } from '../artefatos.js';
import { orgIdDaPasta } from '../org-config.js';
import { buscarAdk } from '../hub.js';
import { resolverAmbiente, type Ctx } from '../ctx.js';

type KindExportavel = 'agent' | 'tool' | 'journey';

/** Kind → pasta no repositório de clientes e rota de export. Mesma tabela do `deploy`. */
const DESTINO_DO_KIND: Record<KindExportavel, { pasta: string; rota: string }> = {
  tool: { pasta: 'tools', rota: 'tools' },
  agent: { pasta: 'agentes', rota: 'agents' },
  journey: { pasta: 'jornadas', rota: 'journeys' },
};

interface Omissao {
  path: string;
  reason: string;
}

/** Os arquivos do pacote de uma tool `runtime: script`, como o Hub os guarda. */
interface PacoteExportado {
  files: Record<string, string>;
  lock: string;
  hash: string;
}

interface ItemExportado {
  slug: string;
  yaml: string;
  /** Conteúdo do `prompt_file:` (só agente) — o YAML não o carrega. */
  prompt?: string;
  omitted?: Omissao[];
  /** O pacote, quando a tool é `runtime: script` e o Hub o tem gravado. */
  pacote?: PacoteExportado;
}

/**
 * Caminho de dentro do pacote que é seguro escrever.
 *
 * Os caminhos vêm do bundle que ALGUÉM publicou. Um `../` ali escreveria fora
 * da pasta do artefato — no repositório de clientes, ou acima dele. A guarda é
 * aqui porque é o único ponto em que dado do Hub vira arquivo no disco de quem
 * exporta.
 */
export function caminhoSeguroDoPacote(relativo: string): boolean {
  if (relativo.length === 0 || relativo.startsWith('/')) return false;
  return !relativo.split('/').some((parte) => parte === '..' || parte === '');
}

interface Ignorado {
  slug: string;
  /** `pii` | `secret` — o próprio NOME do arquivo vazaria. */
  reason: string;
}

interface BundleExportado {
  kind: KindExportavel;
  items: ItemExportado[];
  skipped?: Ignorado[];
}

/** Por que o artefato não virou arquivo — dito de um jeito acionável. */
export function motivoDeIgnorar(ignorado: Ignorado): string {
  return `o próprio nome carregaria ${ignorado.reason === 'secret' ? 'segredo' : 'dado de pessoa'}`;
}

/**
 * Instrução para a omissão que IMPEDE publicar, em vez de só nomeá-la.
 *
 * `definition.lock` não está no registro do Hub: ele nasce do `adk build`, do
 * pacote no disco. Então toda tool `runtime: script` exportada sai sem lock —
 * e o gate exige `hash` E `lock` juntos, porque sem o lock o pacote não é
 * reproduzível. O gate está certo; o que faltava era dizer isso a quem
 * exportou, que só via `invalid_script_hash` no `adk validate` seguinte e não
 * tinha como ligar uma coisa à outra (issue#2782).
 */
const COMO_RESOLVER: Readonly<Record<string, string>> = {
  'definition.lock':
    'traga o pacote (tools/, pyproject.toml) para a pasta deste artefato e rode `adk build`: ' +
    'o lock e o hash nascem dele. Até então o `adk validate` e o apply recusam esta tool.',
};

/**
 * O que ACRESCENTAR ao cabeçalho do YAML — só a instrução.
 *
 * O servidor já escreve `# omitido: <path> — <motivo>` no próprio YAML
 * (`serializeSpecYaml`), e a primeira versão desta função escrevia tudo de
 * novo: o arquivo exportado saía com cada omissão anunciada DUAS vezes, em
 * dois textos diferentes. Achado contra o servidor real — no teste com bundle
 * de mentira o YAML vinha sem cabeçalho, então a duplicação não aparecia.
 *
 * Fica a divisão que faz sentido: o servidor diz O QUE ficou de fora (é ele
 * que sabe), a CLI diz O QUE FAZER quando a omissão impede publicar (é ela que
 * conhece o ciclo local).
 */
export function cabecalhoDeOmissoes(omitidos: readonly Omissao[]): string {
  const linhas = omitidos
    .map((o) => COMO_RESOLVER[o.path])
    .filter((instrucao): instrucao is string => instrucao !== undefined)
    .map((instrucao) => `#   → ${instrucao}`);
  return linhas.length === 0 ? '' : `${linhas.join('\n')}\n`;
}

export function pastaDaOrg(raiz: string, orgId: string, ambiente: string): string | null {
  return listarOrgs(raiz).find((p) => orgIdDaPasta(raiz, p, ambiente) === orgId) ?? null;
}

export async function comandoExport(
  ctx: Ctx,
  opcoes: { org?: string; env?: string; dir?: string; kind?: string; json?: boolean },
): Promise<number> {
  if (!opcoes.org) {
    ctx.err('Informe --org <id da organização>.');
    return 2;
  }
  const kinds: KindExportavel[] = opcoes.kind
    ? [opcoes.kind as KindExportavel]
    : ['tool', 'agent', 'journey'];
  if (kinds.some((k) => !DESTINO_DO_KIND[k])) {
    ctx.err(`--kind aceita ${Object.keys(DESTINO_DO_KIND).join(' | ')}.`);
    return 2;
  }

  const raiz = resolve(ctx.cwd, opcoes.dir ?? '.');
  // Com ADK_HUB_URL e sem perfil, `staging` segue como padrão: export só lê do
  // Hub e escreve localmente, e um id que não bate com a pasta já é recusado.
  const resolvido = resolverAmbiente(ctx, opcoes.env, 'staging');
  if (!resolvido.ok) {
    ctx.err(resolvido.erro);
    return 2;
  }
  const { ambiente } = resolvido;
  const pasta = pastaDaOrg(raiz, opcoes.org, ambiente);
  if (!pasta) {
    // Mesma recusa do `plan`/`deploy`: sem pasta declarada, escrever em
    // `orgs/<orgId>/` inventaria um repositório que ninguém revisou.
    ctx.err(
      `Nenhuma pasta de organização declara "${opcoes.org}" em environments.${ambiente}. ` +
        'Crie `orgs/<pasta>/org.yaml` com esse id antes de exportar.',
    );
    return 2;
  }

  const escritos: string[] = [];
  const ignorados: Ignorado[] = [];
  for (const kind of kinds) {
    let bundle: BundleExportado;
    try {
      bundle = await buscarAdk<BundleExportado>(ctx, `${DESTINO_DO_KIND[kind].rota}/export`, {
        orgId: opcoes.org,
      });
    } catch (e) {
      ctx.err(`${kind}: ${(e as Error).message}`);
      return 1;
    }
    ignorados.push(...(bundle.skipped ?? []));

    for (const item of bundle.items) {
      const destino = join(raiz, 'orgs', pasta, DESTINO_DO_KIND[kind].pasta);
      // Com pacote, o artefato é uma PASTA (`<slug>/manifest.yaml` + arquivos),
      // que é o mesmo formato do `adk init` e o que o `deploy` reconhece para
      // montar o bundle. Sem pacote, segue o `.yaml` solto (issue#2782).
      const arquivo = item.pacote
        ? join(destino, item.slug, 'manifest.yaml')
        : join(destino, `${item.slug}.yaml`);
      mkdirSync(dirname(arquivo), { recursive: true });
      writeFileSync(arquivo, `${cabecalhoDeOmissoes(item.omitted ?? [])}${item.yaml}`);
      escritos.push(arquivo);
      if (item.pacote) {
        for (const [rel, conteudo] of Object.entries(item.pacote.files)) {
          if (!caminhoSeguroDoPacote(rel)) {
            ctx.err(`  ! ${item.slug}: caminho recusado no pacote — ${rel}`);
            continue;
          }
          const alvo = join(destino, item.slug, rel);
          mkdirSync(dirname(alvo), { recursive: true });
          writeFileSync(alvo, conteudo);
          escritos.push(alvo);
        }
        // O `uv.lock` volta como ARQUIVO: é dele que o `adk build`/`deploy`
        // recalcula o hash do pacote, e é o que faltava para o artefato
        // exportado ser reaplicável sem ninguém trazer o código à mão.
        const lock = join(destino, item.slug, 'uv.lock');
        writeFileSync(lock, item.pacote.lock);
        escritos.push(lock);
      }
      // O prompt NÃO viaja no YAML: sem escrevê-lo, o `prompt_file:` do arquivo
      // exportado apontaria para um arquivo inexistente e o `deploy` seguinte
      // falharia na leitura (issue#2681).
      if (item.prompt !== undefined) {
        const md = join(raiz, 'orgs', pasta, 'prompts', `${item.slug}.md`);
        mkdirSync(dirname(md), { recursive: true });
        writeFileSync(md, item.prompt);
        escritos.push(md);
      }
    }
  }

  if (opcoes.json) {
    ctx.out(JSON.stringify({ pasta, escritos, ignorados }, null, 2));
    return 0;
  }
  for (const a of escritos) ctx.out(`  ← ${a.slice(raiz.length + 1)}`);
  for (const s of ignorados) ctx.out(`  ! ${s.slug}: não exportado — ${motivoDeIgnorar(s)}`);
  ctx.out(
    `\n${escritos.length} arquivo(s) escrito(s) em orgs/${pasta}` +
      (ignorados.length > 0 ? ` · ${ignorados.length} ignorado(s)` : '') +
      '. O diff do git é a revisão.',
  );
  return 0;
}
