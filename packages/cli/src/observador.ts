/**
 * O observador de arquivos do `adk dev` (issue#2772).
 *
 * `fs.watch(dir, {recursive:true})` NÃO lança quando o sistema está sem
 * observadores de inotify: devolve um watcher que nunca emite. Medido em
 * dev-1 com um IDE remoto consumindo 119 mil dos 121 mil watches — `adk dev`
 * imprimia "Observando …" e não reagia a save nenhum, sem erro, sem exit code.
 * É o modo de falha pior possível: silêncio idêntico ao sucesso.
 *
 * Por isso a SONDA: um `fs.watch` não-recursivo, que no mesmo estado lança
 * `ENOSPC` em voz alta. Ela roda antes e é descartada em seguida.
 */

import { readdirSync, statSync, watch } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Pastas que nunca interessam ao ciclo de dev — e que dominam o custo do poll.
 *
 * Os caches do Python estão aqui por um motivo mais forte que desempenho: o
 * handler que o `adk dev` acabou de executar REGRAVA o `.pyc`, o observador vê
 * o arquivo novo e executa de novo. Era essa realimentação — e não a falta de
 * debounce — que produzia duas execuções por save (issue#2583): os dois
 * disparos estão a um tick de distância, então nenhum agrupamento os juntaria.
 * O filtro do ramo de tool ainda deixava passar `tools/__pycache__/…`, que
 * começa com "tools".
 */
const IGNORADAS = new Set([
  'node_modules',
  '.venv',
  '.git',
  'dist',
  '.vite',
  'adk-dev',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
]);

/** Artefato de compilação do Python: escrito pela própria execução do handler. */
const EXTENSOES_IGNORADAS = ['.pyc', '.pyo'];

export class SemObservadores extends Error {
  constructor(causa: string) {
    super(
      `Limite de observadores do sistema atingido (${causa}). ` +
        'Rode `adk dev --poll` (não exige privilégio) ou aumente ' +
        '`fs.inotify.max_user_watches`.',
    );
    this.name = 'SemObservadores';
  }
}

/**
 * Lança `SemObservadores` se o sistema não tem mais watches. O modo recursivo
 * do Node engole esse erro; o não-recursivo não.
 */
export function sondarObservadores(raiz: string): void {
  try {
    watch(raiz, { recursive: false }).close();
  } catch (erro) {
    const codigo = (erro as NodeJS.ErrnoException).code;
    if (codigo === 'ENOSPC') throw new SemObservadores('fs.inotify.max_user_watches');
    throw erro;
  }
}

function arquivos(raiz: string, dir = raiz, achados: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (IGNORADAS.has(nome)) continue;
    const caminho = join(dir, nome);
    try {
      if (statSync(caminho).isDirectory()) arquivos(raiz, caminho, achados);
      else if (!EXTENSOES_IGNORADAS.some((e) => nome.endsWith(e))) achados.push(caminho);
    } catch {
      // Arquivo que sumiu entre o listar e o medir não é erro do ciclo de dev.
    }
  }
  return achados;
}

function mtimes(raiz: string): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const caminho of arquivos(raiz)) {
    try {
      mapa.set(caminho, statSync(caminho).mtimeMs);
    } catch {
      /* idem */
    }
  }
  return mapa;
}

/** Polling por mtime — a saída sem privilégio quando o inotify acabou. */
export function observarPorPoll(
  raiz: string,
  aoSalvar: (arquivos: string[]) => void,
  intervaloMs = 1000,
): () => void {
  let anterior = mtimes(raiz);
  const timer = setInterval(() => {
    const atual = mtimes(raiz);
    const mudados: string[] = [];
    for (const [caminho, mtime] of atual) {
      if (anterior.get(caminho) !== mtime) mudados.push(relative(raiz, caminho).split(sep).join('/'));
    }
    anterior = atual;
    // Um tick, uma chamada: o mesmo save aparece em dois arquivos (o `.py` e o
    // `chamadas.log` que o próprio handler escreveu) e cada ciclo de poll
    // entregava um evento por arquivo (issue#2583).
    if (mudados.length > 0) aoSalvar(mudados);
  }, intervaloMs);
  // Sem `unref()`, de propósito: no `adk dev --poll` este timer É o mecanismo
  // que mantém o comando vivo. Com `unref()` o Node não o considera trabalho
  // pendente, o processo encerra o loop e o poll nunca dispara — medido: três
  // formas de save, zero reexecuções. O teste unitário não pegava porque o
  // laço de espera dele segurava o loop por fora.
  return () => clearInterval(timer);
}

/**
 * Agrupa eventos próximos num LOTE (issue#2583).
 *
 * Um save gera mais de um evento no inotify (`rename` + `change`, e o editor
 * que escreve por arquivo temporário gera mais ainda), e no poll o mesmo save
 * aparece junto do arquivo que o próprio handler acabou de escrever. Sem isso
 * o ciclo de dev roda duas ou três vezes por Ctrl-S.
 */
function comDebounce(
  aoSalvar: (arquivos: string[]) => void,
  ms: number,
): (arquivo: string) => void {
  const pendentes = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  return (arquivo: string) => {
    pendentes.add(arquivo);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const lote = [...pendentes];
      pendentes.clear();
      timer = undefined;
      aoSalvar(lote);
    }, ms);
  };
}

export const DEBOUNCE_PADRAO_MS = 200;

export function observar(
  raiz: string,
  aoSalvar: (arquivos: string[]) => void,
  opcoes: { poll?: boolean; debounceMs?: number } = {},
): () => void {
  // No poll o próprio tick já agrupa; o debounce cobre o inotify, que entrega
  // um evento por operação de arquivo.
  if (opcoes.poll) return observarPorPoll(raiz, aoSalvar);
  sondarObservadores(raiz);
  const emLote = comDebounce(aoSalvar, opcoes.debounceMs ?? DEBOUNCE_PADRAO_MS);
  const watcher = watch(raiz, { recursive: true }, (_evento, arquivo) => {
    if (!arquivo) return;
    const rel = String(arquivo).split(sep).join('/');
    // Mesmo filtro do poll: no inotify cada escrita de cache é um evento
    // próprio, e cada uma virava um ciclo de dev.
    if (rel.split('/').some((parte) => IGNORADAS.has(parte))) return;
    if (EXTENSOES_IGNORADAS.some((e) => rel.endsWith(e))) return;
    emLote(rel);
  });
  return () => watcher.close();
}
