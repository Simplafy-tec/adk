/**
 * Junta classes, descartando o que for falsy.
 *
 * ponytail: sem `clsx`/`tailwind-merge` — o pacote público não precisa de duas
 * dependências para um `filter().join()`. Se algum dia um componente daqui
 * tiver de resolver CONFLITO de utilitário Tailwind (`p-2` vs `p-4` vindos de
 * `className`), aí sim entra o `tailwind-merge`.
 */
export function cn(...partes: Array<string | false | null | undefined>): string {
  return partes.filter(Boolean).join(' ');
}
