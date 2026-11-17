import { cn } from './cn.js';

export interface BrandProps {
  /** `mark` = só o símbolo; `lockup` = símbolo + nome. */
  variant?: 'mark' | 'lockup';
  /** Altura do símbolo em px. */
  size?: number;
  className?: string;
}

/**
 * `<Brand/>` — o ÚNICO ponto de logo da Simplafy num app.
 *
 * É por isso que o lint de aderência reprova `<img>` e SVG de logo solto: hoje
 * o par claro/escuro está repetido à mão em 6 telas do hub-v2, e cada troca de
 * marca vira uma caça ao arquivo. Aqui o SVG é INLINE (asset servido pelo Hub
 * não existe do lado do app) e pinta com `currentColor` + `var(--color-primary)`
 * — o que faz a marca acompanhar a troca de tema sem um segundo arquivo e sem
 * rebuild.
 */
export function Brand({ variant = 'lockup', size = 24, className }: BrandProps) {
  return (
    <span
      data-slot="brand"
      role="img"
      aria-label="Simplafy"
      className={cn('inline-flex items-center gap-2 text-foreground', className)}
    >
      <svg
        height={size}
        viewBox="0 0 75 61"
        fill="none"
        aria-hidden="true"
        focusable="false"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M17.149 46.9V21.43H12.964V13.709H17.149V11.256C17.149 3.89601 20.828 0 28.188 0H35.259V7.93701H31.507C28.837 7.93701 27.466 9.236 27.466 11.905V13.709H34.465V21.43H27.466V46.9H17.149ZM45.759 60.176L51.026 46.828L37.966 13.709H48.573L56.004 32.686L63.581 13.709H74.187L55.716 60.176H45.759Z"
          fill="currentColor"
        />
        <path
          d="M6.76401 48.403C10.5 48.403 13.529 45.374 13.529 41.638C13.529 37.903 10.5 34.874 6.76401 34.874C3.02901 34.874 0 37.903 0 41.638C0 45.374 3.02901 48.403 6.76401 48.403Z"
          fill="var(--color-primary)"
        />
      </svg>
      {variant === 'lockup' ? (
        <span className="font-display font-semibold tracking-tight">Simplafy</span>
      ) : null}
    </span>
  );
}
