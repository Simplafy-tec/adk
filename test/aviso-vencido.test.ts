import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * issue#2771 — o aviso "recusado com `unknown_kind` até a N10" sobreviveu à
 * própria N10 em oito pontos: duas skills do plugin, o `list_components` (que
 * é o que um agente consulta como fonte viva) e o template do `server.py`.
 *
 * Aviso vencido é pior que aviso nenhum: quem lê não tem como saber que a
 * informação venceu, e deixa de tentar justamente o que já funciona. Este
 * teste é a guarda contra a reincidência — barata, e o único jeito de a
 * promessa não sobreviver à entrega que ela anuncia.
 *
 * O que se proíbe é a PROMESSA ("até a N<n>", "chega na N<n>"), não a citação
 * histórica ("aplicam desde a N10"), que é fato datado e continua verdadeira.
 */
const RAIZ = fileURLToPath(new URL('..', import.meta.url));
const PASTAS = ['plugin', 'packages'];
// `.md` inclui os READMEs dos pacotes — `packages/cli/package.json` publica o
// seu no tarball, então é o único destes pontos que sai da nossa máquina.
const EXTENSOES = ['.md', '.ts', '.tsx'];
// `test/` fica de fora: o alvo é o que o AUTOR lê (skill, saída de comando,
// template gerado). Um teste que cita a frase antiga entre aspas para explicar
// o conserto de ontem não engana ninguém.
const IGNORADOS = new Set(['node_modules', 'dist', 'storybook-static', '.turbo', 'test']);
// Duas redes, porque a primeira versão deste teste nasceu com um buraco do
// tamanho de uma palavra: "até a **fatia** N10" escapava de `\s+N\d+` e
// sobreviveu no README do pacote publicado — o texto que um dev externo lê
// primeiro. Agora o gatilho tolera palavras no meio, e a co-ocorrência de
// `unknown_kind` com um número de fatia na mesma linha reprova sozinha.
// `\w` em JS sem flag `u` é `[A-Za-z0-9_]`: "até a **próxima** fatia N22"
// escapava por causa do acento. `[^\s]` não tem esse buraco.
const PROMESSA_FUTURA =
  /(até a|até à|chega na|chega n|a partir da|ainda não|previsto para)(?:\s+[^\s]+){0,3}\s+N\d+/i;
const RECUSA_DATADA = /unknown_kind[^\n]*\bN\d+|\bN\d+[^\n]*unknown_kind/i;

function arquivos(dir: string): string[] {
  const achados: string[] = [];
  for (const nome of readdirSync(dir)) {
    if (IGNORADOS.has(nome)) continue;
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) achados.push(...arquivos(caminho));
    else if (EXTENSOES.some((e) => nome.endsWith(e))) achados.push(caminho);
  }
  return achados;
}

describe('aviso vencido de fatia', () => {
  it('nenhum arquivo do plugin ou dos pacotes promete algo "até a N<n>"', () => {
    const infratores: string[] = [];
    for (const pasta of PASTAS) {
      for (const caminho of arquivos(join(RAIZ, pasta))) {
        const conteudo = readFileSync(caminho, 'utf8');
        conteudo.split('\n').forEach((linha, i) => {
          if (PROMESSA_FUTURA.test(linha) || RECUSA_DATADA.test(linha)) {
            infratores.push(`${caminho.slice(RAIZ.length)}:${i + 1}: ${linha.trim()}`);
          }
        });
      }
    }
    expect(infratores).toEqual([]);
  });
});
