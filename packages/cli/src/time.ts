/**
 * Pacote de time (`kind: team`, ADR-290): `team.yaml` na raiz da pasta.
 *
 * O contrato público julga a ESTRUTURA do arquivo (mesmo código e mesmo `path` que o servidor). Aqui a CLI soma o que só ela
 * enxerga: os arquivos que uma peça `spec:` aponta (existem, ficam dentro do pacote) e o vazamento (segredo, PII, id interno) em todo
 * texto do pacote. O que NÃO se confere aqui, e vai dito no `checks[]`: que a função de uma peça `call:` existe no catálogo do MCP
 * completo, e a soma do especialista com o amplo — o catálogo e o pacote do amplo estão no Hub.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  checkAgainstPolicy,
  parseSpecYaml,
  scanLeaks,
  validateSpecStructureAs,
  type SpecIssue,
} from '@simpla.fy/adk-contract';
import { carregarPolitica } from './hub.js';
import { lerTexto, listarArquivos } from './pacote.js';
import type { Ctx } from './ctx.js';

export const ARQUIVO_DO_TIME = 'team.yaml';

export interface ChecagemDoTime {
  nome: string;
  ok: boolean;
  detalhe?: string;
}

export interface JulgamentoDoTime {
  issues: SpecIssue[];
  checks: ChecagemDoTime[];
  /** Soma dos bytes do pacote. */
  bytes: number;
}

interface PecaLida {
  /** Caminho da peça no arquivo (`pecas[2]` ou `doSegmento.pecas[0]`), o mesmo do contrato. */
  path: string;
  call?: { ferramenta?: unknown };
  spec?: { arquivo?: unknown };
}

const eObjeto = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Peças declaradas no arquivo, em qualquer forma (a estrutura já foi julgada pelo contrato; aqui só se lê). */
function pecasDoArquivo(spec: Record<string, unknown>): PecaLida[] {
  const lista = (valor: unknown, base: string): PecaLida[] =>
    Array.isArray(valor)
      ? valor.flatMap((p, i) =>
          eObjeto(p)
            ? [
                {
                  path: `${base}[${i}]`,
                  call: eObjeto(p.call) ? p.call : undefined,
                  spec: eObjeto(p.spec) ? p.spec : undefined,
                },
              ]
            : [],
        )
      : [];
  return [
    ...lista(spec.pecas, 'pecas'),
    ...(eObjeto(spec.doSegmento) ? lista(spec.doSegmento.pecas, 'doSegmento.pecas') : []),
  ];
}

/** `rel` (de `path.relative`) sai da pasta: `..`, `../x` ou absoluto. Um arquivo chamado `..nome` fica DENTRO. */
function saiDaPasta(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function arquivoDaPecaFicaNoPacote(raiz: string, abs: string): boolean {
  try {
    return !saiDaPasta(relative(realpathSync(raiz), realpathSync(abs)));
  } catch {
    return false;
  }
}

/** Julga um pacote de time já localizado em `raiz` (a pasta que contém `team.yaml`). */
export function julgarPacoteDeTime(raiz: string): JulgamentoDoTime {
  const issues: SpecIssue[] = [];
  const checks: ChecagemDoTime[] = [];
  const spec = parseSpecYaml(readFileSync(join(raiz, ARQUIVO_DO_TIME), 'utf8')) as Record<
    string,
    unknown
  >;

  // Estrutura: o mesmo motor do servidor, ancorado no kind `team` (um `kind: tool` aqui vira `kind_mismatch`).
  issues.push(...validateSpecStructureAs('team', spec as never));

  // O catálogo do Hub exige a pasta com o nome do slug; vale também aqui, onde a identidade é a do pacote.
  const slug = spec.slug;
  if (typeof slug === 'string' && slug !== basename(raiz)) {
    issues.push({
      code: 'slug_filename_mismatch',
      path: 'slug',
      message: `O slug "${slug}" é diferente do nome da pasta "${basename(raiz)}".`,
    });
  }

  const arquivos = listarArquivos(raiz);
  const bytes = arquivos.reduce((total, a) => total + a.bytes, 0);
  for (const a of arquivos) {
    if (!a.texto) continue;
    // `checkSlug: false`: o arquivo se chama `team.yaml` em todo pacote; a identidade é a da pasta (conferida acima).
    issues.push(...scanLeaks(lerTexto(a), { filename: a.rel, checkSlug: false }));
  }

  const pecas = pecasDoArquivo(spec);
  let comArquivo = 0;
  for (const p of pecas) {
    if (!p.spec || typeof p.spec.arquivo !== 'string' || p.spec.arquivo === '') continue;
    comArquivo += 1;
    const alvo = `${p.path}.spec.arquivo`;
    const abs = resolve(raiz, p.spec.arquivo);
    if (isAbsolute(p.spec.arquivo) || saiDaPasta(relative(raiz, abs))) {
      issues.push({
        code: 'team_piece_file_outside_package',
        path: alvo,
        message: `O arquivo "${p.spec.arquivo}" fica fora do pacote do time.`,
      });
    } else if (!existsSync(abs) || !statSync(abs).isFile()) {
      issues.push({
        code: 'team_piece_file_missing',
        path: alvo,
        message: `O arquivo "${p.spec.arquivo}" não existe no pacote do time.`,
      });
    } else if (!arquivoDaPecaFicaNoPacote(raiz, abs)) {
      // Atalho (symlink) que sai da pasta: o caminho escrito parece interno, o arquivo lido não é.
      issues.push({
        code: 'team_piece_file_outside_package',
        path: alvo,
        message: `O arquivo "${p.spec.arquivo}" aponta, por atalho, para fora do pacote do time.`,
      });
    }
  }
  if (comArquivo > 0) {
    checks.push({
      nome: 'peças spec',
      ok: true,
      detalhe: `${comArquivo} peça(s) apontam para arquivo do pacote (existência conferida aqui; o conteúdo é julgado pelo apply do tipo, no Hub)`,
    });
  }

  const chamadas = pecas.filter((p) => p.call);
  if (chamadas.length > 0) {
    const funcoes = [
      ...new Set(
        chamadas.map((p) => p.call?.ferramenta).filter((f): f is string => typeof f === 'string'),
      ),
    ].sort();
    checks.push({
      nome: 'peças call',
      ok: true,
      detalhe: `${chamadas.length} peça(s) chamam o MCP completo (${funcoes.join(', ')}): a função só é conferida no servidor, que tem o catálogo`,
    });
  }

  if (spec.tipo === 'especialista' && typeof spec.herda === 'string') {
    checks.push({
      nome: 'herança',
      ok: true,
      detalhe: `herda de "${spec.herda}": a soma com o amplo (equipe, peças, naoHerda) só é conferida onde o pacote do amplo está — no Hub`,
    });
  }

  return { issues, checks, bytes };
}

/** `adk build` numa pasta que tem `team.yaml` (e não `manifest.yaml`). */
export async function comandoBuildTime(ctx: Ctx, raiz: string): Promise<number> {
  const { issues, checks, bytes } = julgarPacoteDeTime(raiz);
  const { policy } = await carregarPolitica(ctx);
  issues.push(...checkAgainstPolicy({ kind: 'team', packageSizeBytes: bytes }, policy));
  checks.push({ nome: 'tamanho', ok: true, detalhe: `${bytes} bytes` });
  ctx.out(JSON.stringify({ issues, checks }, null, 2));
  return issues.length > 0 || checks.some((c) => !c.ok) ? 1 : 0;
}

/** Subpasta com `team.yaml`. Atalho quebrado, arquivo ou pasta ilegível não são pacote (e não derrubam o comando). */
function ehPastaDePacote(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, ARQUIVO_DO_TIME));
  } catch {
    return false;
  }
}

/**
 * Pacotes de time sob `raiz`: a própria pasta, se tem `team.yaml`; senão cada subpasta direta que tem (o catálogo do Hub,
 * `apps/api/src/times/catalogo/<slug>/team.yaml`). Ordem alfabética, para a saída ser estável.
 */
export function pacotesDeTime(raiz: string): string[] {
  if (existsSync(join(raiz, ARQUIVO_DO_TIME))) return [raiz];
  let nomes: string[];
  try {
    nomes = readdirSync(raiz).sort();
  } catch {
    return [];
  }
  return nomes.map((n) => join(raiz, n)).filter(ehPastaDePacote);
}

/** `adk validate` apontado para um pacote de time ou para uma pasta de pacotes. Devolve o exit code. */
export function validarTimes(ctx: Ctx, pacotes: string[], json: boolean): number {
  const relatorio = pacotes.map((dir) => {
    const { issues, checks } = julgarPacoteDeTime(dir);
    return { pacote: basename(dir), kind: 'team', issues, checks };
  });
  const comProblema = relatorio.filter((r) => r.issues.length > 0);
  if (json) {
    ctx.out(JSON.stringify({ artefatos: relatorio }, null, 2));
  } else {
    for (const r of relatorio) {
      if (r.issues.length === 0) {
        ctx.out(`  ✓ team/${r.pacote}`);
        continue;
      }
      ctx.out(`  ✗ team/${r.pacote}`);
      for (const i of r.issues) ctx.out(`      ${i.code} ${i.path}: ${i.message}`);
    }
    ctx.out(`\n${relatorio.length} time(s), ${comProblema.length} com problema.`);
  }
  return comProblema.length > 0 ? 1 : 0;
}
