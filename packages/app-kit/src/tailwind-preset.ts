/**
 * Preset Tailwind público — recorte de `simplafy-ui/src/tailwind-preset.ts`.
 *
 * Podado de propósito: `sidebar-*`, `topbar-h` e a paleta de gráficos são cromo
 * do produto e não entram no vocabulário de um app de cliente.
 *
 * Tipado como `Record<string, unknown>` para não arrastar `tailwindcss` como
 * dependência do pacote — quem consome já tem o Tailwind instalado.
 */

const cores = [
  'background',
  'foreground',
  'card',
  'popover',
  'primary',
  'secondary',
  'muted',
  'accent',
  'destructive',
  'success',
  'warning',
  'info',
] as const;

const paleta: Record<string, unknown> = {
  border: 'var(--color-border)',
  input: 'var(--color-input)',
  ring: 'var(--color-ring)',
};
for (const c of cores) {
  paleta[c] = { DEFAULT: `var(--color-${c})`, foreground: `var(--color-${c}-foreground)` };
}

export const simplafyAppPreset: Record<string, unknown> = {
  // Classe, não media query — é o que o `use-theme.ts` do Hub liga, e é o que
  // faz a troca de tema pela ponte valer sem rebuild.
  darkMode: 'class',
  theme: {
    extend: {
      colors: paleta,
      fontFamily: {
        sans: ['var(--font-sans)'],
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: {
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        '3xl': 'var(--radius-3xl)',
        pill: 'var(--radius-pill)',
      },
    },
  },
};

export default simplafyAppPreset;
