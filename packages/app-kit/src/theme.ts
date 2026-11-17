/**
 * Tema — mesmo vocabulário e mesma mecânica do `use-theme.ts` do hub-v2.
 *
 * A troca é por CLASSE `.dark` no elemento raiz, NÃO por injeção de variável
 * CSS uma a uma. Parece detalhe e não é: o design system usa
 * `@custom-variant dark (&:where(.dark, .dark *))`, então um app que injetasse
 * variáveis funcionaria no shell local e ficaria com metade dos utilitários
 * `dark:` mortos dentro do Hub real.
 */

export type Theme = 'light' | 'dark' | 'system';

export function resolverTema(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  const escuro =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  return escuro ? 'dark' : 'light';
}

/** Aplica o tema ao documento. Sem efeito fora do navegador (SSR/teste em node). */
export function applyTheme(theme: Theme, raiz?: HTMLElement): void {
  const alvo = raiz ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (!alvo) return;
  alvo.classList.toggle('dark', resolverTema(theme) === 'dark');
}
