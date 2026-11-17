/**
 * Os mesmos tokens de `tokens/tokens.css`, legíveis em JS.
 *
 * Existe para o `HostShell` INJETAR o tema no iframe e para o Storybook listar
 * a paleta. O valor canônico continua sendo o CSS: aqui só moram os NOMES das
 * variáveis, nunca uma cor literal duplicada — duas listas de cor divergiriam
 * no primeiro ajuste de marca.
 */

export const COLOR_TOKENS = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'success',
  'success-foreground',
  'warning',
  'warning-foreground',
  'info',
  'info-foreground',
  'border',
  'input',
  'ring',
] as const;

export const FONT_TOKENS = ['sans', 'display', 'mono'] as const;

export const RADIUS_TOKENS = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'pill'] as const;

export type ColorToken = (typeof COLOR_TOKENS)[number];
export type FontToken = (typeof FONT_TOKENS)[number];
export type RadiusToken = (typeof RADIUS_TOKENS)[number];

/** `color('primary')` → `var(--color-primary)`. É assim que o app cita cor. */
export function color(token: ColorToken): string {
  return `var(--color-${token})`;
}

export function font(token: FontToken): string {
  return `var(--font-${token})`;
}

export function radius(token: RadiusToken): string {
  return `var(--radius-${token})`;
}

export const tokens = { colors: COLOR_TOKENS, fonts: FONT_TOKENS, radii: RADIUS_TOKENS };
