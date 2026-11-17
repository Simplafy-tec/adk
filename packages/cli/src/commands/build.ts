/**
 * `adk build` — o portão local, com o MESMO motor do servidor.
 *
 * Ordem: contrato (estrutura) → vazamento (segredo/PII/id interno) → runtime
 * (`uv lock`, `ruff`) → política (tamanho, limits da classe script). A saída é JSON de propósito: o
 * `issues[]` é o mesmo shape que o apply devolve em `blocking[]`, e é assim que
 * o mutation check dos dois lados compara maçã com maçã.
 */

import { builtinModules } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  checkAgainstPolicy,
  checkScriptLimits,
  parseSpecYaml,
  scanLeaks,
  validateSpecStructure,
  type SpecIssue,
} from '@simpla.fy/adk-contract';
import { executar } from '../exec.js';
import { KINDS_PORTAO_PROFUNDO, NOTA_PORTAO_PROFUNDO } from '../kinds-profundos.js';
import { carregarPolitica } from '../hub.js';
import { ARQUIVO_DO_TIME, comandoBuildTime } from '../time.js';
import { lerTexto, listarArquivos } from '../pacote.js';
import { ARQUIVO_PACOTE_NODE, detectarRuntimeMcp } from './dev-mcp.js';
import type { Ctx } from '../ctx.js';

interface Checagem {
  nome: string;
  ok: boolean;
  detalhe?: string;
}

export async function comandoBuild(ctx: Ctx, opcoes: { dir?: string }): Promise<number> {
  const raiz = resolve(ctx.cwd, opcoes.dir ?? '.');
  const manifesto = join(raiz, 'manifest.yaml');
  // Pacote de time (ADR-290): `team.yaml` na raiz, no lugar do `manifest.yaml`.
  if (!existsSync(manifesto) && existsSync(join(raiz, ARQUIVO_DO_TIME))) {
    return comandoBuildTime(ctx, raiz);
  }
  const issues: SpecIssue[] = [];
  const checks: Checagem[] = [];

  if (!existsSync(manifesto)) {
    ctx.out(
      JSON.stringify(
        {
          issues: [
            {
              code: 'invalid_document',
              path: 'manifest.yaml',
              message:
                'Não encontrei manifest.yaml (nem team.yaml) — rode dentro da pasta do componente.',
            },
          ],
          checks,
        },
        null,
        2,
      ),
    );
    return 1;
  }

  const textoManifesto = readFileSync(manifesto, 'utf8');
  const spec = parseSpecYaml(textoManifesto);
  issues.push(...validateSpecStructure(spec));
  // `checkSlug: false`: aqui a identidade é a do PACOTE, não a do arquivo — o
  // manifesto se chama `manifest.yaml` em todo componente. A regra vale no
  // repositório de clientes, onde o nome do arquivo É o slug.
  issues.push(...scanLeaks(textoManifesto, { filename: 'manifest.yaml', checkSlug: false }));

  const kind = String((spec as { kind?: unknown }).kind ?? 'tool');
  const arquivos = listarArquivos(raiz);
  const textos: { path: string; text: string }[] = [];
  for (const arquivo of arquivos) {
    if (!arquivo.texto || arquivo.rel === 'manifest.yaml') continue;
    const texto = lerTexto(arquivo);
    textos.push({ path: arquivo.rel, text: texto });
    issues.push(...scanLeaks(texto, { filename: arquivo.rel, checkSlug: false }));
  }

  if (existsSync(join(raiz, 'pyproject.toml'))) {
    const lock = await executar(ctx, 'uv', ['lock'], { cwd: raiz });
    checks.push({ nome: 'uv lock', ok: lock.ok, detalhe: lock.ok ? undefined : lock.saida });
    const ruff = await executar(ctx, 'uv', ['run', 'ruff', 'check', '.'], { cwd: raiz });
    checks.push({ nome: 'ruff check', ok: ruff.ok, detalhe: ruff.ok ? undefined : ruff.saida });
  }
  // Equivalente Node do par `uv lock`+`ruff`: sem isto o `checks[]` de um
  // satélite `kind: mcp --runtime node` saía com só `{nome:'tamanho'}` — o
  // portão mudo (item 4/7, Hub#2.6.26.4). Escopo restrito a `mcp`: `kind: app`
  // já tem `package.json` hoje e não faz parte desta fatia.
  if (kind === 'mcp' && existsSync(join(raiz, ARQUIVO_PACOTE_NODE))) {
    checks.push(checarDependenciasNode(raiz, textos));
  }

  const { policy } = await carregarPolitica(ctx);
  const bytes = arquivos.reduce((total, a) => total + a.bytes, 0);
  // `files` só é lido pela política quando `kind: app` — é o lint de aderência,
  // a MESMA função pura que o apply do Hub chama (GATE 3).
  const daPolitica = checkAgainstPolicy({ kind, packageSizeBytes: bytes, files: textos }, policy);
  issues.push(...daPolitica);
  // `limits` da tool `runtime: script` contra o teto da classe —
  // mesmo código (`limits_over_budget`) que o apply do Hub devolve.
  issues.push(...checkScriptLimits((spec as { definition?: unknown }).definition, policy));
  if (kind === 'app') {
    const reprovadas = daPolitica.filter((i) => i.code === 'ui_adherence');
    checks.push({
      nome: 'ui_adherence',
      ok: reprovadas.length === 0,
      detalhe: reprovadas.length === 0 ? undefined : `${reprovadas.length} violação(ões)`,
    });
  }
  checks.push({ nome: 'tamanho', ok: true, detalhe: `${bytes} bytes` });

  // Gate honesto (issue#2768): para `mcp`, `app` e `table` o contrato público
  // NÃO julga o artefato — quem julga é o apply. Sair verde e calado fazia o
  // autor ler ✓ de um portão que sabe que não olhou, e o servidor recusar em
  // seguida por campo que nada documentava.
  const profundo = KINDS_PORTAO_PROFUNDO[kind];
  const contrato = profundo
    ? {
        parcial: true,
        julgado_por: 'apply do Hub',
        campos_obrigatorios: profundo.campos,
        nota: NOTA_PORTAO_PROFUNDO,
      }
    : undefined;

  ctx.out(JSON.stringify({ issues, checks, ...(contrato ? { contrato } : {}) }, null, 2));
  return issues.length > 0 || checks.some((c) => !c.ok) ? 1 : 0;
}

/**
 * Especificadores importados por um arquivo JS/TS: `from '…'`, `import '…'`,
 * `import('…')` dinâmico e `require('…')`.
 */
const RE_IMPORT =
  /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Comentários fora antes de procurar import: `// import x from 'y'` não é
 * dependência. É uma varredura heurística e linear, não um parser: ela separa
 * string, template (com as expressões `${ … }` aninhadas), literal de regex e
 * comentário, para que barra-asterisco, `//`, aspa ou crase DENTRO deles não
 * abram um falso comentário que apague o import seguinte. Barra-asterisco sem
 * fechamento adiante é texto comum: código válido não tem comentário de bloco
 * aberto até o fim do arquivo.
 *
 * Limites conhecidos: texto JSX (um glob ou uma URL solta entre tags) não é
 * reconhecido e ainda pode ser lido como comentário; e regex logo depois do
 * `)` de uma condição (`if (x) /re/`) é lida como divisão, porque o `)` não
 * diz se fechou uma condição ou um valor. Quando a heurística erra,
 * o erro tende a deixar código a mais — import dentro de string ou regex vira
 * dependência acusada a mais —, mas não há garantia de que nunca esconda um.
 */
function semComentarios(codigo: string): string {
  const ultimoFechamentoDeBloco = codigo.lastIndexOf('*/');
  // Profundidade de `{` dentro de cada `${ … }` aberto: a `}` que fecha a
  // expressão é a que chega com profundidade 0, e o texto do template recomeça.
  const chavesPorExpressao: number[] = [];
  let saida = '';
  // Último token significativo fora de comentário: um caractere de pontuação,
  // a palavra inteira (com `.` na frente quando é propriedade, como `obj.of`)
  // ou `FIM_DE_VALOR`. Decide se `/` abre regex ou é divisão, sem olhar
  // para trás na saída (o que deixaria a varredura quadrática).
  let anterior = '';
  let continuandoPalavra = false;

  const emitirTextoDeTemplate = (inicio: number): number => {
    const { fim, abriuExpressao } = fimDoTextoDoTemplate(codigo, inicio);
    saida += codigo.slice(inicio, fim);
    if (abriuExpressao) chavesPorExpressao.push(0);
    anterior = abriuExpressao ? '{' : '`';
    continuandoPalavra = false;
    return fim;
  };

  let i = 0;
  while (i < codigo.length) {
    const atual = codigo[i]!;
    const proximo = codigo[i + 1];
    const topo = chavesPorExpressao.length - 1;
    if (atual === "'" || atual === '"') {
      const fim = fimDaString(codigo, i);
      saida += codigo.slice(i, fim);
      anterior = atual;
      continuandoPalavra = false;
      i = fim;
    } else if (atual === '`') {
      i = emitirTextoDeTemplate(i);
    } else if (atual === '}' && topo >= 0 && chavesPorExpressao[topo] === 0) {
      chavesPorExpressao.pop();
      i = emitirTextoDeTemplate(i);
    } else if (atual === '/' && proximo === '/') {
      const fimDaLinha = codigo.indexOf('\n', i);
      i = fimDaLinha === -1 ? codigo.length : fimDaLinha;
    } else if (atual === '/' && proximo === '*' && ultimoFechamentoDeBloco >= i + 2) {
      i = codigo.indexOf('*/', i + 2) + 2;
      saida += ' ';
    } else if (atual === '/' && podeAbrirRegex(anterior)) {
      const fim = fimDaRegex(codigo, i);
      saida += codigo.slice(i, fim);
      anterior = '/';
      continuandoPalavra = false;
      i = fim;
    } else {
      if (topo >= 0 && atual === '{') chavesPorExpressao[topo]! += 1;
      if (topo >= 0 && atual === '}') chavesPorExpressao[topo]! -= 1;
      saida += atual;
      if (/\s/.test(atual)) {
        continuandoPalavra = false;
      } else if (/[\w$]/.test(atual)) {
        if (continuandoPalavra) anterior += atual;
        else anterior = anterior === '.' ? `.${atual}` : atual;
        continuandoPalavra = true;
      } else {
        anterior = tokenDePontuacao(atual, codigo[i - 1], anterior, continuandoPalavra);
        continuandoPalavra = false;
      }
      i++;
    }
  }
  return saida;
}

/** Fecha um valor: depois dele, `/` é divisão. */
const FIM_DE_VALOR = ')';

/**
 * `++`/`--` colados e o non-null do TypeScript (`!` colado em identificador,
 * `)` ou `]`, como `x!`, `f()!`, `a[0]!`) terminam um valor, não pedem um.
 */
function tokenDePontuacao(
  atual: string,
  colado: string | undefined,
  anterior: string,
  depoisDePalavra: boolean,
): string {
  if ((atual === '+' || atual === '-') && colado === atual && anterior === atual) {
    return FIM_DE_VALOR;
  }
  const depoisDeFechamento = (anterior === ')' || anterior === ']') && colado === anterior;
  if (atual === '!' && (depoisDePalavra || depoisDeFechamento)) return FIM_DE_VALOR;
  return atual;
}

/** Depois destes, `/` abre literal de regex; depois de valor (nome, número, `)`, `]`), é divisão. */
const PONTUACAO_ANTES_DE_REGEX = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const PALAVRAS_ANTES_DE_REGEX = new Set([
  'return',
  'typeof',
  'case',
  'default',
  'do',
  'else',
  'in',
  'of',
  'void',
  'yield',
  'await',
  'delete',
  'throw',
  'new',
]);

function podeAbrirRegex(anterior: string): boolean {
  return (
    anterior === '' ||
    PONTUACAO_ANTES_DE_REGEX.has(anterior) ||
    PALAVRAS_ANTES_DE_REGEX.has(anterior)
  );
}

/** Índice logo após a aspa que fecha a string aberta em `inicio`. */
function fimDaString(codigo: string, inicio: number): number {
  const aspa = codigo[inicio];
  let i = inicio + 1;
  while (i < codigo.length) {
    const atual = codigo[i];
    if (atual === '\\') {
      i += 2;
      continue;
    }
    if (atual === aspa) return i + 1;
    // String comum não atravessa linha: aspa sem par não engole o arquivo.
    if (atual === '\n') return i;
    i++;
  }
  return codigo.length;
}

/**
 * Texto de template a partir de `inicio` (a crase de abertura ou a `}` que
 * fecha uma expressão) até a crase que fecha o template ou o `${` seguinte.
 */
function fimDoTextoDoTemplate(
  codigo: string,
  inicio: number,
): { fim: number; abriuExpressao: boolean } {
  let i = inicio + 1;
  while (i < codigo.length) {
    const atual = codigo[i];
    if (atual === '\\') {
      i += 2;
      continue;
    }
    if (atual === '`') return { fim: i + 1, abriuExpressao: false };
    if (atual === '$' && codigo[i + 1] === '{') return { fim: i + 2, abriuExpressao: true };
    i++;
  }
  return { fim: codigo.length, abriuExpressao: false };
}

/** Índice logo após a `/` que fecha o literal de regex aberto em `inicio` (a `/` de `[…]` não fecha). */
function fimDaRegex(codigo: string, inicio: number): number {
  let i = inicio + 1;
  let dentroDeClasse = false;
  while (i < codigo.length) {
    const atual = codigo[i];
    if (atual === '\\') {
      i += 2;
      continue;
    }
    // Regex não atravessa linha: uma `/` mal classificada não engole o arquivo.
    if (atual === '\n') return i;
    if (atual === '[') dentroDeClasse = true;
    else if (atual === ']') dentroDeClasse = false;
    else if (atual === '/' && !dentroDeClasse) return i + 1;
    i++;
  }
  return codigo.length;
}

function nomeDoPacote(especificador: string): string {
  return especificador.startsWith('@')
    ? especificador.split('/').slice(0, 2).join('/')
    : especificador.split('/')[0]!;
}

interface PackageJsonNode {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  imports?: Record<string, unknown>;
}

/** `#x` declarado no campo `imports` — chave exata ou padrão com `*`. */
function subpathDeclarado(especificador: string, imports: Record<string, unknown>): boolean {
  return Object.keys(imports).some((chave) => {
    const curinga = chave.indexOf('*');
    if (curinga === -1) return chave === especificador;
    return (
      especificador.startsWith(chave.slice(0, curinga)) &&
      especificador.endsWith(chave.slice(curinga + 1))
    );
  });
}

/**
 * Item 4/7, Hub#2.6.26.4 — o espelho exato da lição paga em `test/init.test.ts`
 * (Python): o `server.py` gerado importava `mcp` e o `pyproject.toml`
 * declarava `[]`. Aqui, sem `node_modules` instalado, é uma checagem ESTÁTICA
 * contra `package.json` — mais barata que `npm ls`, e roda mesmo antes do
 * `npm install` (o esqueleto recém-gerado passa, sem exigir instalação).
 */
function checarDependenciasNode(raiz: string, textos: { path: string; text: string }[]): Checagem {
  const nome = 'dependências node';
  let conteudo: unknown;
  try {
    conteudo = JSON.parse(readFileSync(join(raiz, ARQUIVO_PACOTE_NODE), 'utf8'));
  } catch (erro) {
    const motivo = erro instanceof Error ? erro.message : String(erro);
    return { nome, ok: false, detalhe: `${ARQUIVO_PACOTE_NODE} inválido: ${motivo}` };
  }
  // `null`, número ou lista são JSON válido: o `JSON.parse` aceita e o acesso a
  // `.dependencies` estourava fora do contrato JSON da saída.
  if (typeof conteudo !== 'object' || conteudo === null || Array.isArray(conteudo)) {
    return {
      nome,
      ok: false,
      detalhe: `${ARQUIVO_PACOTE_NODE} inválido: o conteúdo precisa ser um objeto JSON`,
    };
  }
  const pkg = conteudo as PackageJsonNode;
  const declaradas = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);
  const faltando = new Set<string>();
  const extensoesFonte = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
  for (const arquivo of textos) {
    if (!extensoesFonte.has(arquivo.path.slice(arquivo.path.lastIndexOf('.')))) continue;
    for (const m of semComentarios(arquivo.text).matchAll(RE_IMPORT)) {
      const especificador = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (!especificador || especificador.startsWith('.') || especificador.startsWith('node:')) {
        continue;
      }
      if (especificador.startsWith('#')) {
        if (!subpathDeclarado(especificador, pkg.imports ?? {})) faltando.add(especificador);
        continue;
      }
      const pacote = nomeDoPacote(especificador);
      if (builtinModules.includes(pacote)) continue;
      if (!declaradas.has(pacote)) faltando.add(pacote);
    }
  }
  return {
    nome,
    ok: faltando.size === 0,
    detalhe:
      faltando.size === 0
        ? undefined
        : `Import(s) não declarado(s) no ${ARQUIVO_PACOTE_NODE}: ${[...faltando].join(', ')}`,
  };
}

/** `adk test` — a suíte do componente, no runtime que o build já preparou. */
export async function comandoTest(ctx: Ctx, opcoes: { dir?: string }): Promise<number> {
  const raiz = resolve(ctx.cwd, opcoes.dir ?? '.');
  const manifesto = join(raiz, 'manifest.yaml');
  // Só `kind: mcp` tem runtime Node nesta fatia — `kind: app` também tem
  // `package.json` e continua fora deste despacho. `server.py` presente é
  // sempre Python, mesmo com um `package.json` na pasta por outro motivo
  // (mesma detecção do `adk dev`, `detectarRuntimeMcp`).
  const kind = existsSync(manifesto)
    ? String((parseSpecYaml(readFileSync(manifesto, 'utf8')) as { kind?: unknown }).kind ?? '')
    : '';
  if (kind === 'mcp' && detectarRuntimeMcp(raiz) === 'node') {
    return comandoTestNode(ctx, raiz);
  }
  // A linha do comando entra na saída mesmo quando o subprocesso (real ou
  // falso, em teste) não imprime nada — é a evidência de QUAL comando rodou.
  ctx.out('$ uv run pytest');
  const pytest = await executar(ctx, 'uv', ['run', 'pytest'], { cwd: raiz });
  ctx.out(pytest.saida);
  return pytest.ok ? 0 : 1;
}

async function comandoTestNode(ctx: Ctx, raiz: string): Promise<number> {
  if (!existsSync(join(raiz, 'node_modules'))) {
    ctx.err(`node_modules não encontrado em ${raiz} — rode \`npm install\` antes do \`adk test\`.`);
    return 2;
  }
  const npmTest = await executar(ctx, 'npm', ['test'], { cwd: raiz });
  ctx.out(npmTest.saida);
  return npmTest.ok ? 0 : 1;
}
