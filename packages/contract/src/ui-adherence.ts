/**
 * Lint de aderência ao design system (`ui_adherence`, ADR-120 §5).
 *
 * Mesma forma do `scan-leaks.ts`: lista de `Regra` + varredura de TEXTO +
 * `SpecIssue[]`. É de propósito que não seja um plugin de oxlint/eslint — o
 * apply do Hub roda esta mesma função no servidor, e um runtime de lint lá
 * dentro é inviável. Texto e regex é o único formato que atravessa a fronteira
 * sem levar um bundler junto (GATE 3: "mesmo resultado no build e no apply").
 *
 * As regras são as "Regras de Ouro" de `simplafy-ui/COMPONENTS.md`:
 * nunca hardcodar cor, nunca declarar fonte fora do token, logo só por
 * `<Brand/>`.
 */

import type { SpecIssue } from './spec-gates.js';

/**
 * Só arquivo de UI é lintado. Sem este recorte, o `#` de um título de Markdown
 * ou de um comentário de YAML viraria "cor literal" — falso positivo que
 * ensinaria o time a ignorar o código.
 */
const UI_EXTENSOES = ['.tsx', '.jsx', '.ts', '.js', '.mjs', '.css', '.scss', '.html'];

interface RegraUi {
  re: RegExp;
  message: string;
}

const REGRAS: RegraUi[] = [
  {
    re: /#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3}(?:[0-9a-fA-F]{2})?)?\b/,
    message:
      'cor literal em hexadecimal — use o token do design system (`var(--color-*)` ou a classe Tailwind do preset)',
  },
  {
    re: /\b(?:rgba?|hsla?|oklch)\s*\(/,
    message:
      'cor literal em função de cor — use o token do design system (`var(--color-*)` ou a classe Tailwind do preset)',
  },
  {
    // Declarar a fonte só é permitido apontando para o token (`var(--font-*)`).
    re: /\b(?:font-family|fontFamily)\s*:\s*(?!["']?\s*var\(--font)/i,
    message: 'fonte fora do token — use `var(--font-sans)` / `var(--font-mono)` do design system',
  },
  {
    re: /<img[\s/>]/i,
    message: 'logo/imagem fora de `<Brand/>` — o logo da Simplafy só é renderizado por `<Brand/>`',
  },
  {
    re: /<svg\b[^>]*(?:id|class|className|aria-label)=["'][^"']*logo/i,
    message: 'logo em SVG inline — o logo da Simplafy só é renderizado por `<Brand/>`',
  },
];

export interface ArquivoUi {
  /** Caminho relativo ao pacote — vira o `path` da issue. */
  path: string;
  text: string;
}

export function ehArquivoDeUi(path: string): boolean {
  return UI_EXTENSOES.some((ext) => path.toLowerCase().endsWith(ext));
}

/**
 * Uma issue por arquivo e por regra violada. Função PURA: nada de fs, nada de
 * rede — é o que permite ao servidor chamá-la com o texto que recebeu no apply.
 */
export function checkUiAdherence(arquivos: readonly ArquivoUi[]): SpecIssue[] {
  const issues: SpecIssue[] = [];
  for (const arquivo of arquivos) {
    if (!ehArquivoDeUi(arquivo.path)) continue;
    for (const regra of REGRAS) {
      if (regra.re.test(arquivo.text)) {
        issues.push({ code: 'ui_adherence', path: arquivo.path, message: regra.message });
      }
    }
  }
  return issues;
}
