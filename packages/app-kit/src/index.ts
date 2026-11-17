/**
 * `@simpla.fy/app-kit` — o kit PÚBLICO para construir apps do Hub.
 *
 * Regra de fronteira (ADR-121 §2): nada exclusivo do produto sai daqui. Só
 * token, componente base, `<Brand/>`, a ponte e o shell. Componente de tela do
 * Hub (estúdio de agente, console de BI, inbox, jornada) é do produto e fica no
 * `@simplafy-tec/ui`, que é privado — a auditoria do tarball em
 * `test/publish.test.ts` reprova se algum atravessar.
 */

export * from './bridge.js';
export * from './theme.js';
export * from './tokens.js';
export * from './tailwind-preset.js';
export * from './cn.js';
export * from './use-host.js';
export * from './brand.js';
export * from './host-shell.js';
export * from './components/badge.js';
export * from './components/button.js';
export * from './components/card.js';
export * from './components/dialog.js';
export * from './components/input.js';
export * from './components/select.js';
export * from './components/switch.js';
export * from './components/toast.js';
