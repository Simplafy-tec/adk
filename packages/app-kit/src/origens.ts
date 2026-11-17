/**
 * Quem é host confiável para um app do Hub — sem React, de propósito.
 *
 * Mora fora do `use-host.ts` porque a CLI precisa ler estas portas para
 * escolher onde subir o shell do `adk dev` (issue#2765), e ela não importa
 * React. A decisão de confiança continua sendo UMA: quem muda a lista muda
 * para os dois lados.
 */

/** Origens do Hub. Ambiente novo entra aqui, não num regex. */
export const HOST_ORIGINS_PADRAO: readonly string[] = [
  'https://app.simplafy.com.br',
  'https://app-staging.simplafy.com.br',
];

/** Hosts locais que um app SERVIDO localmente aceita como host. */
export const HOSTS_LOCAIS: readonly string[] = ['127.0.0.1', 'localhost'];

/**
 * Portas locais confiáveis: o shell do `adk dev` (`4321`, `5173`) e o
 * Storybook (`6006`). Porta fora desta lista deixa `hostOrigin` nulo e a ponte
 * vira no-op silencioso — correto como decisão de segurança, e a razão de o
 * `adk dev` ter de escolher a porta do shell DENTRO dela.
 */
export const PORTAS_SHELL_LOCAL: readonly string[] = ['4321', '5173', '6006'];
