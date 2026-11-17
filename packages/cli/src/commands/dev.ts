/**
 * `adk dev` — revalida e executa o handler a cada save.
 *
 * Sem watcher de terceiro: `fs.watch` recursivo cobre `manifest.yaml` e
 * `tools/**` e não acrescenta dependência ao pacote publicado.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseSpecYaml, validateSpecStructure } from '@simpla.fy/adk-contract';
import { devApp, PORTA_DEV_PADRAO } from './dev-app.js';
import {
  encerrarJuntoComOProcesso,
  erroDependenciasNode,
  erroSemServidor,
  faltamDependenciasNode,
  faltaServidor,
  supervisor,
  ARQUIVO_SERVIDOR,
  ARQUIVO_PACOTE_NODE,
} from './dev-mcp.js';
import { observar, SemObservadores } from '../observador.js';
import { executar } from '../exec.js';
import type { Ctx } from '../ctx.js';

export async function comandoDev(
  ctx: Ctx,
  opcoes: { dir?: string; port?: number; poll?: boolean },
): Promise<number> {
  const raiz = resolve(ctx.cwd, opcoes.dir ?? '.');
  const manifesto = join(raiz, 'manifest.yaml');
  if (!existsSync(manifesto)) {
    ctx.err('Não encontrei manifest.yaml — rode dentro da pasta do componente.');
    return 2;
  }

  // `kind: app` não tem handler Python para executar a cada save: o ciclo dele
  // é o Vite (HMR) dentro do Hub shell local.
  const spec = parseSpecYaml(readFileSync(manifesto, 'utf8')) as { kind?: unknown; slug?: unknown };
  if (spec.kind === 'app') {
    return devApp(
      ctx,
      raiz,
      String(spec.slug ?? 'app'),
      opcoes.port ?? PORTA_DEV_PADRAO,
      opcoes.poll ?? false,
    );
  }

  // `kind: mcp` não tem handler para executar: o ciclo dele é o servidor de
  // pé (FastMCP ou Node), reiniciado a cada save (issue#2764).
  if (spec.kind === 'mcp') {
    if (faltaServidor(raiz)) return erroSemServidor(ctx, raiz);
    // Satélite Node: sem `node_modules/` não há `npm run dev` para spawnar —
    // falha ANTES de qualquer spawn, com mensagem acionável (molde do "Vite
    // não encontrado" de `devApp`).
    if (faltamDependenciasNode(raiz)) return erroDependenciasNode(ctx, raiz);
    const revalidar = (): boolean => {
      const issues = validateSpecStructure(parseSpecYaml(readFileSync(manifesto, 'utf8')));
      for (const i of issues) ctx.out(`  ✗ ${i.code} ${i.path}: ${i.message}`);
      return issues.length === 0;
    };
    ctx.out(`Observando ${raiz} — Ctrl-C para sair.`);
    revalidar();
    const servidor = supervisor(ctx, raiz);
    encerrarJuntoComOProcesso(servidor);
    const erroObservador = ligarObservador(ctx, raiz, opcoes.poll, (arquivos) => {
      const interessa = (a: string): boolean =>
        a === 'manifest.yaml' ||
        a === ARQUIVO_SERVIDOR ||
        a === ARQUIVO_PACOTE_NODE ||
        a.startsWith('tools') ||
        a.startsWith('src');
      if (!arquivos.some(interessa)) return;
      revalidar();
      servidor.reiniciar();
    });
    if (erroObservador !== 0) {
      servidor.encerrar();
      return erroObservador;
    }
    return new Promise<number>(() => {});
  }

  const entrada = join(raiz, 'dev', 'sample-input.json');

  const rodar = async (): Promise<void> => {
    const issues = validateSpecStructure(parseSpecYaml(readFileSync(manifesto, 'utf8')));
    if (issues.length > 0) {
      for (const i of issues) ctx.out(`  ✗ ${i.code} ${i.path}: ${i.message}`);
      return;
    }
    if (!existsSync(entrada)) {
      ctx.out('  ! dev/sample-input.json não existe — sem entrada para executar.');
      return;
    }
    const script = [
      'import json,sys,glob,importlib.util',
      "caminho = sorted(glob.glob('tools/*.py'))[0]",
      "spec = importlib.util.spec_from_file_location('tool', caminho)",
      'modulo = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(modulo)',
      "print(json.dumps(modulo.handler(json.load(open('dev/sample-input.json'))), ensure_ascii=False))",
    ].join('\n');
    const r = await executar(ctx, 'uv', ['run', 'python', '-c', script], { cwd: raiz });
    ctx.out(r.ok ? `  → ${r.saida}` : `  ✗ ${r.saida}`);
  };

  ctx.out(`Observando ${raiz} — Ctrl-C para sair.`);
  await rodar();
  // `.env.local` (nunca versionado) é carregado pelo próprio `uv run`; a CLI
  // não o lê nem o imprime.
  const erroObservador = ligarObservador(ctx, raiz, opcoes.poll, (arquivos) => {
    // Um LOTE por save (issue#2583): o ciclo roda UMA vez, mesmo quando o save
    // toca `manifest.yaml` e `tools/*.py` juntos.
    if (!arquivos.some((a) => a === 'manifest.yaml' || a.startsWith('tools'))) return;
    void rodar();
  });
  if (erroObservador !== 0) return erroObservador;
  return new Promise<number>(() => {});
}

/**
 * Liga o observador e devolve 0, ou o exit code da falha já reportada.
 *
 * "Observando …" sem observador é a falha que a issue#2772 descreve: o modo
 * recursivo do `fs.watch` engole o `ENOSPC` e devolve um watcher mudo. Aqui a
 * falha vira mensagem e exit code — o comando não finge estar observando.
 */
function ligarObservador(
  ctx: Ctx,
  raiz: string,
  poll: boolean | undefined,
  aoSalvar: (arquivos: string[]) => void,
): number {
  try {
    observar(raiz, aoSalvar, { poll });
    return 0;
  } catch (erro) {
    if (erro instanceof SemObservadores) {
      ctx.err(erro.message);
      return 1;
    }
    throw erro;
  }
}
