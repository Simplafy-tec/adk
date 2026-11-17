/**
 * Ponte `postMessage` entre o app (iframe) e o Hub (host) — ADR-120 §5.
 *
 * O envelope é versionado (`v: 1`) porque host e app são publicados em
 * cadências diferentes: o Hub em produção vai conversar com apps compilados
 * meses antes, e uma mensagem que o host não sabe ler tem de ser DESCARTADA,
 * não interpretada pela metade.
 *
 * Quatro camadas de defesa, na ordem do `zernio-wizard.tsx` do hub-v2 (o
 * prior art de listener sério da casa):
 *
 *   C-1  origem na allowlist  — `event.origin` exato, nunca `*`, nunca regex;
 *   R-1  versão conhecida     — `v` literal, senão descarta;
 *   R-2  type conhecido       — união fechada, não um switch com default;
 *   R-3  payload no schema    — zod por tipo de mensagem.
 *
 * Nada FALHA ALTO aqui: quem manda é um iframe não confiável, então mensagem
 * fora do contrato vira `null` e o host segue vivo. Lançar daria ao remetente
 * um jeito de derrubar o listener do host.
 *
 * E o corolário que vem do `use-channels.ts:719` do hub-v2 — "a fonte é o
 * servidor, NUNCA o postMessage": nenhum campo de AUTORIDADE (organização,
 * usuária, token, papel) existe neste contrato. O app pede efeito de UI; quem
 * decide se pode é o host, com o que ele já sabe da sessão.
 */

import { z } from 'zod';

/** Versão do envelope. Bump só com host capaz de ler as duas. */
export const BRIDGE_VERSION = 1;

/**
 * Variantes do `toast-store.ts` do hub-v2, byte a byte: inventar uma quinta
 * aqui daria um toast que o host não sabe renderizar.
 */
export const ToastPayloadSchema = z.object({
  variant: z.enum(['success', 'error', 'warning', 'info']),
  title: z.string().min(1),
  description: z.string().optional(),
  duration: z.number().int().positive().optional(),
});
export type ToastPayload = z.infer<typeof ToastPayloadSchema>;

/** Espelha `ModalConfirmProps` do `@simplafy-tec/ui` — é o que o host renderiza. */
export const DialogPayloadSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  description: z.string().optional(),
  cancelLabel: z.string().optional(),
  confirmLabel: z.string().optional(),
  confirmVariant: z.enum(['default', 'destructive']).optional(),
});
export type DialogPayload = z.infer<typeof DialogPayloadSchema>;

/** Vocabulário do `use-theme.ts` do hub-v2 — 'light' | 'dark' | 'system'. */
export const ThemePayloadSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
});
export type ThemePayload = z.infer<typeof ThemePayloadSchema>;

/**
 * Um `path` só é aceito se RESOLVER para a mesma origem do Hub.
 *
 * A regex `/^\/[^/\\]/` sozinha não basta e era um open redirect real: o parser
 * WHATWG remove U+0000-U+001F e U+007F ANTES de resolver, então `/<TAB>/evil.com`
 * passa no formato e vira origem externa. Medido:
 *
 *   new URL('/<TAB>/evil.com', 'https://hub.example.com').href
 *     === 'https://evil.com/'      // idem LF, CR e '/<TAB>\\evil.com'
 *
 * Efeito: app hostil no iframe manda `navigate` e leva a ABA DO HUB para o
 * atacante — o phishing que o sandbox sem `allow-top-navigation` impede,
 * reintroduzido por software.
 *
 * ⚠️ Duplicata cross-repo declarada: `apps/web/src/lib/apps/app-bridge.ts`
 * (simplafy-hub-v2) tem o MESMO contrato — corrigido lá em `5b4b2f99`.
 */
export function caminhoInternoSeguro(path: string): boolean {
  if (!/^\/[^/\\]/.test(path)) return false;
  try {
    return new URL(path, 'https://x.invalid').origin === 'https://x.invalid';
  } catch {
    return false;
  }
}

/** Caminho INTERNO do Hub. Ver `caminhoInternoSeguro`: o formato não basta. */
export const NavigatePayloadSchema = z.object({
  path: z
    .string()
    .refine(caminhoInternoSeguro, 'caminho interno do Hub, começando por "/"'),
});
export type NavigatePayload = z.infer<typeof NavigatePayloadSchema>;

export const ReadyPayloadSchema = z.object({
  slug: z.string().optional(),
  /** Altura desejada do iframe, em px — o host decide se acata. */
  height: z.number().positive().optional(),
});
export type ReadyPayload = z.infer<typeof ReadyPayloadSchema>;

const v = z.literal(BRIDGE_VERSION);

export const BridgeMessageSchema = z.discriminatedUnion('type', [
  z.object({ v, type: z.literal('toast'), payload: ToastPayloadSchema }),
  z.object({ v, type: z.literal('dialog'), payload: DialogPayloadSchema }),
  z.object({ v, type: z.literal('theme'), payload: ThemePayloadSchema }),
  z.object({ v, type: z.literal('navigate'), payload: NavigatePayloadSchema }),
  z.object({ v, type: z.literal('ready'), payload: ReadyPayloadSchema }),
]);
export type BridgeMessage = z.infer<typeof BridgeMessageSchema>;
export type BridgeMessageType = BridgeMessage['type'];

/** O mínimo de um `MessageEvent` que a validação precisa — testável sem DOM. */
export interface IncomingEvent {
  origin: string;
  data: unknown;
}

/**
 * Valida uma mensagem recebida. Devolve o envelope ou `null` — nunca lança.
 *
 * `allowlist` é comparada por igualdade EXATA de origem (`scheme://host:port`).
 * Prefixo ou `endsWith` aceitaria `https://hub.example.com.evil.com`.
 */
export function parseIncoming(
  evento: IncomingEvent,
  allowlist: readonly string[],
): BridgeMessage | null {
  // C-1 — origem
  if (!allowlist.includes(evento.origin)) return null;
  // R-1/R-2/R-3 — versão, type e payload, de uma vez pela união fechada
  const analisada = BridgeMessageSchema.safeParse(evento.data);
  return analisada.success ? analisada.data : null;
}

/** Monta um envelope válido — o único construtor de mensagem do pacote. */
export function envelope<T extends BridgeMessageType>(
  type: T,
  payload: Extract<BridgeMessage, { type: T }>['payload'],
): BridgeMessage {
  return { v: BRIDGE_VERSION, type, payload } as BridgeMessage;
}

/**
 * Envia ao destino com `targetOrigin` EXPLÍCITO. `'*'` não é aceito: mandar
 * para qualquer origem entrega o conteúdo a quem quer que tenha embutido a
 * página.
 */
export function postMessageTo(
  destino: Pick<Window, 'postMessage'>,
  mensagem: BridgeMessage,
  targetOrigin: string,
): void {
  if (!targetOrigin || targetOrigin === '*') {
    throw new Error('targetOrigin explícito é obrigatório na ponte do app-kit.');
  }
  destino.postMessage(mensagem, targetOrigin);
}
