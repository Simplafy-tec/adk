/**
 * Contrato do `adk init`: o esqueleto gerado tem de PASSAR nos próprios
 * comandos que a CLI manda rodar em seguida (`adk build`, `adk test`).
 *
 * POR QUE ISTO EXISTE
 * -------------------
 * O template de `kind: mcp` nascia quebrado: `server.py` importa
 * `mcp.server.fastmcp`, mas o `pyproject.toml` saía com `dependencies = []`.
 * O `uv sync` do `adk test` montava um venv sem a biblioteca e a suíte morria
 * na COLETA, antes de qualquer asserção:
 *
 *     E   ModuleNotFoundError: No module named 'mcp'
 *     !!!! Interrupted: 1 error during collection !!!!
 *
 * Ou seja: o primeiro comando que a própria CLI sugere ao usuário (o README e a
 * mensagem do `init` mandam rodar `adk build`/`adk test`) falhava num projeto
 * recém-criado, sem uma linha escrita por quem o criou. Encontrado ao montar o
 * protótipo fim a fim do ADK.
 *
 * O `kind: tool` não tinha o problema porque o handler gerado só usa a stdlib.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { comandoInit } from '../packages/cli/src/commands/init.js';

function criar(kind: 'tool' | 'mcp' | 'app', nome: string) {
  const raiz = mkdtempSync(join(tmpdir(), 'adk-init-'));
  const saida: string[] = [];
  const codigo = comandoInit(
    { cwd: raiz, out: (m: string) => saida.push(m), err: (m: string) => saida.push(m) } as never,
    kind,
    nome,
    {},
  );
  return { raiz: join(raiz, nome), codigo, saida: saida.join('\n') };
}

describe('adk init — o esqueleto gerado é utilizável sem edição', () => {
  it('kind: mcp declara a dependência que o server.py importa', () => {
    const { raiz } = criar('mcp', 'satelite-de-teste');
    const server = readFileSync(join(raiz, 'server.py'), 'utf-8');
    const pyproject = readFileSync(join(raiz, 'pyproject.toml'), 'utf-8');

    // A premissa do teste: o template realmente importa a biblioteca.
    // Se um dia o server.py deixar de usar FastMCP, este teste deve ser
    // revisto — não silenciosamente satisfeito.
    expect(server).toContain('from mcp.server.fastmcp import FastMCP');

    const bloco = /dependencies = \[(.*?)\]/s.exec(pyproject)?.[1] ?? '';
    expect(bloco, 'pyproject.toml de kind:mcp precisa declarar `mcp`').toMatch(/["']mcp[>=~<]/);

    // O teto importa tanto quanto a dependência. Só `mcp>=1.2` resolve para a
    // 2.x, onde `FastMCP` virou `MCPServer` — e o `adk test` volta a morrer na
    // coleta, com outra mensagem e no mesmo lugar. Medido em runtime, não
    // suposto: a primeira versão deste fix declarava `>=1.2` e reproduzia.
    expect(bloco, 'a faixa precisa de teto: FastMCP não existe na 2.x').toMatch(/<\s*2/);
  });

  it('kind: tool continua sem dependência de runtime (só stdlib)', () => {
    // Guarda contra o conserto preguiçoso: adicionar `mcp` para TODO mundo
    // faria a tool baixar um servidor MCP que ela nunca usa.
    const { raiz } = criar('tool', 'tool-de-teste');
    const pyproject = readFileSync(join(raiz, 'pyproject.toml'), 'utf-8');
    const bloco = /dependencies = \[(.*?)\]/s.exec(pyproject)?.[1] ?? '';
    expect(bloco.trim()).toBe('');
  });

  it('kind: app não emite pyproject.toml (é Vite/React, não Python)', () => {
    const { raiz } = criar('app', 'app-de-teste');
    expect(existsSync(join(raiz, 'pyproject.toml'))).toBe(false);
    expect(existsSync(join(raiz, 'package.json'))).toBe(true);
  });
});
