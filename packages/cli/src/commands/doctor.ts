/**
 * `adk doctor` — a máquina atende à política da plataforma?
 *
 * Roda contra `GET /api/v1/adk/policy` para que o requisito venha do produto e
 * não de uma constante da CLI que envelhece na mão de quem instalou uma versão
 * antiga. Sem o endpoint, cai para a política embutida e DIZ que caiu.
 */

import { executar } from '../exec.js';
import { carregarPolitica } from '../hub.js';
import type { Ctx } from '../ctx.js';

interface Checagem {
  nome: string;
  ok: boolean;
  encontrado: string;
  requerido: string;
}

/** `>=20`, `>=0.4` — compara numericamente, componente a componente. */
function atende(versao: string, requisito: string): boolean {
  const alvo = requisito.replace(/^>=\s*/, '');
  const a = numeros(versao);
  const b = numeros(alvo);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function numeros(v: string): number[] {
  return (v.match(/\d+/g) ?? []).map(Number);
}

function primeiraVersao(texto: string): string {
  return texto.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? texto.trim();
}

export async function comandoDoctor(ctx: Ctx): Promise<number> {
  const { policy, origem, detalhe } = await carregarPolitica(ctx);
  const checagens: Checagem[] = [];

  const node = process.versions.node;
  checagens.push({
    nome: 'node',
    ok: atende(node, policy.runtimes.node),
    encontrado: `v${node}`,
    requerido: policy.runtimes.node,
  });

  const python = await executar(ctx, 'python3', ['--version']);
  const versaoPython = python.ok ? primeiraVersao(python.saida) : '';
  const pythonOk = policy.runtimes.python.some((p) => versaoPython.startsWith(p));
  // `python3` fora da versão exigida não é veredito final: o `uv` gerencia
  // interpretadores, e é ele que o `adk build`/`adk test` vai usar.
  const uvPython = pythonOk
    ? null
    : await executar(ctx, 'uv', ['python', 'find', policy.runtimes.python[0]]);
  checagens.push({
    nome: `python ${policy.runtimes.python.join('/')}`,
    ok: pythonOk || uvPython?.ok === true,
    encontrado: python.ok ? versaoPython : 'não encontrado',
    requerido: policy.runtimes.python.join(' | '),
  });

  const uv = await executar(ctx, 'uv', ['--version']);
  checagens.push({
    nome: 'uv',
    ok: uv.ok && atende(primeiraVersao(uv.saida), policy.runtimes.uv),
    encontrado: uv.ok ? primeiraVersao(uv.saida) : 'não encontrado',
    requerido: policy.runtimes.uv,
  });

  const git = await executar(ctx, 'git', ['--version']);
  checagens.push({
    nome: 'git',
    ok: git.ok,
    encontrado: git.ok ? primeiraVersao(git.saida) : 'não encontrado',
    requerido: 'qualquer',
  });

  const largura = Math.max(...checagens.map((c) => c.nome.length));
  ctx.out(
    origem === 'hub'
      ? 'Política da plataforma: vinda do Hub.'
      : `Política da plataforma: política embutida (fallback${detalhe ? ` — ${detalhe}` : ''}).`,
  );
  ctx.out('');
  for (const c of checagens) {
    ctx.out(
      `  ${c.ok ? '✓' : '✗'} ${c.nome.padEnd(largura)}  ${c.encontrado.padEnd(16)} requer ${c.requerido}`,
    );
  }
  const faltando = checagens.filter((c) => !c.ok);
  ctx.out('');
  ctx.out(
    faltando.length === 0
      ? `Tudo certo — spec_version aceita: ${policy.spec_versions.join(', ')}.`
      : `${faltando.length} requisito(s) não atendido(s): ${faltando.map((c) => c.nome).join(', ')}.`,
  );
  return faltando.length === 0 ? 0 : 1;
}
