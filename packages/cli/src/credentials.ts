/**
 * Credenciais do `adk login` — `~/.config/simplafy-adk/credentials.json`, 0600.
 *
 * Fora do projeto de propósito: refresh token dentro do repositório acaba
 * versionado. O arquivo é um mapa POR URL DE HUB — a mesma máquina fala com
 * staging e produção, e o token de um nunca pode ser usado no outro.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface HubCredentials {
  client_id: string;
  redirect_uri: string;
  refresh_token: string;
  access_token: string;
  /** Epoch em ms do fim do access token — a CLI renova antes de usar. */
  expires_at: number;
  user: string;
}

export interface CredentialsLocation {
  hubUrl: string;
  /** Sobrescreve o diretório padrão (usado nos testes). */
  configDir?: string;
}

const ARQUIVO = 'credentials.json';

export function configDirPadrao(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'simplafy-adk');
}

function caminho(loc: CredentialsLocation): string {
  return join(loc.configDir ?? configDirPadrao(), ARQUIVO);
}

/** Chave do mapa: a URL do Hub normalizada (sem barra final). */
function chave(hubUrl: string): string {
  return hubUrl.replace(/\/+$/, '');
}

function lerTudo(loc: CredentialsLocation): Record<string, HubCredentials> {
  try {
    const bruto: unknown = JSON.parse(readFileSync(caminho(loc), 'utf8'));
    if (!bruto || typeof bruto !== 'object') return {};
    return bruto as Record<string, HubCredentials>;
  } catch {
    return {};
  }
}

/**
 * Grava o mapa de credenciais com 0600. `mode` no `writeFileSync` só vale na
 * CRIAÇÃO: num arquivo que já existia (ou com umask permissivo) o segredo
 * ficaria legível por todo mundo em silêncio — daí o `chmodSync` depois.
 */
function gravarTudo(arquivo: string, tudo: Record<string, HubCredentials>): void {
  writeFileSync(arquivo, `${JSON.stringify(tudo, null, 2)}\n`, { mode: 0o600 });
  chmodSync(arquivo, 0o600);
}

export async function saveCredentials(
  loc: CredentialsLocation,
  creds: HubCredentials,
): Promise<void> {
  const dir = loc.configDir ?? configDirPadrao();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tudo = lerTudo(loc);
  tudo[chave(loc.hubUrl)] = creds;
  gravarTudo(caminho(loc), tudo);
}

export async function loadCredentials(
  loc: CredentialsLocation,
): Promise<HubCredentials | undefined> {
  return lerTudo(loc)[chave(loc.hubUrl)];
}

export async function clearCredentials(loc: CredentialsLocation): Promise<void> {
  const tudo = lerTudo(loc);
  delete tudo[chave(loc.hubUrl)];
  try {
    gravarTudo(caminho(loc), tudo);
  } catch {
    // Sem arquivo não há o que limpar.
  }
}
