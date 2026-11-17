import { describe, expect, it } from 'vitest';
import { PORTAS_SHELL_LOCAL } from '../../app-kit/src/origens.js';
import { PORTAS_CONFIAVEIS_DO_SHELL, portaDoShell } from '../src/commands/dev-app.js';

// issue#2765 — a ponte do `adk dev` nascia morta porque o shell subia em
// `portaApp + 1` (5174 no default) e o `useHost()` do app só confia em
// 4321/5173/6006. `hostOrigin` ficava `null` e a ponte virava no-op nos dois
// sentidos, sem erro: a tela abria e parecia certa.

describe('porta do shell do adk dev', () => {
  it('a lista da CLI não pode divergir da allowlist do app-kit', () => {
    expect(PORTAS_CONFIAVEIS_DO_SHELL.map(String)).toEqual([...PORTAS_SHELL_LOCAL]);
  });

  it('a porta escolhida é sempre confiável pelo app, para qualquer porta de app', () => {
    for (const portaApp of [4321, 5173, 5174, 6006, 3000, 8080]) {
      const shell = portaDoShell(portaApp);
      expect(PORTAS_CONFIAVEIS_DO_SHELL).toContain(shell);
      expect(shell).not.toBe(portaApp);
    }
  });

  it('não é mais portaApp + 1', () => {
    // Mutation check em forma de teste: voltando a `portaApp + 1`, o default
    // (5173) daria 5174 — a origem que o app recusa.
    expect(portaDoShell(5173)).not.toBe(5174);
  });
});
