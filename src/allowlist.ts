/**
 * Allowlist Management
 * Loads and checks phone numbers against inbound/outbound allowlists
 *
 * @module allowlist
 */

import { readFileSync, existsSync, watchFile } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface Allowlist {
  inbound: string[];
  outbound: string[];
}

let cachedAllowlist: Allowlist | null = null;
let allowlistPath: string | null = null;

/**
 * Normalize a phone number by removing all non-digit characters
 */
export function normalizeNumber(input: string | undefined | null): string {
  if (!input) return "";
  return input.replace(/\D/g, "");
}

/**
 * Extract the phone number from an endpoint string
 * e.g., "PJSIP/trunk-provider/6596542555" → "6596542555"
 * e.g., "SIP/6596542555@provider" → "6596542555"
 * e.g., "PJSIP/6596542555" → "6596542555"
 */
export function extractNumberFromEndpoint(endpoint: string): string {
  // Try to find a sequence of digits that looks like a phone number (7+ digits)
  const matches = endpoint.match(/\d{7,}/g);
  if (matches && matches.length > 0) {
    // Return the longest match (most likely the full phone number)
    return matches.reduce((a, b) => (a.length >= b.length ? a : b));
  }
  return "";
}

/**
 * Load the allowlist from allowlist.json
 */
export function loadAllowlist(customPath?: string): Allowlist {
  const filePath = customPath || resolve(__dirname, "../allowlist.json");
  allowlistPath = filePath;

  if (!existsSync(filePath)) {
    console.warn(`[Allowlist] File not found: ${filePath} — using empty allowlist`);
    cachedAllowlist = { inbound: [], outbound: [] };
    return cachedAllowlist;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);

    cachedAllowlist = {
      inbound: Array.isArray(data.inbound) ? data.inbound.map(normalizeNumber) : [],
      outbound: Array.isArray(data.outbound) ? data.outbound.map(normalizeNumber) : [],
    };

    console.log(
      `[Allowlist] Loaded — inbound: ${cachedAllowlist.inbound.length}, outbound: ${cachedAllowlist.outbound.length}`
    );

    return cachedAllowlist;
  } catch (err) {
    console.error(`[Allowlist] Failed to load ${filePath}:`, err);
    cachedAllowlist = { inbound: [], outbound: [] };
    return cachedAllowlist;
  }
}

/**
 * Watch the allowlist file for changes and reload automatically
 */
export function watchAllowlist(): void {
  if (!allowlistPath || !existsSync(allowlistPath)) return;

  watchFile(allowlistPath, { interval: 5000 }, () => {
    console.log("[Allowlist] File changed, reloading...");
    loadAllowlist(allowlistPath!);
  });
}

/**
 * Get the current allowlist (loads if not cached)
 */
export function getAllowlist(): Allowlist {
  if (!cachedAllowlist) {
    return loadAllowlist();
  }
  return cachedAllowlist;
}

/**
 * Check if a phone number is allowed for outbound calls
 */
export function isOutboundAllowed(endpoint: string): boolean {
  const allowlist = getAllowlist();

  // If allowlist is empty, allow all (open mode)
  if (allowlist.outbound.length === 0) {
    return true;
  }

  const number = extractNumberFromEndpoint(endpoint);
  if (!number) {
    console.warn(`[Allowlist] Could not extract number from endpoint: ${endpoint}`);
    return false;
  }

  const allowed = allowlist.outbound.includes(number);
  if (!allowed) {
    console.warn(`[Allowlist] Outbound blocked: ${number} (from ${endpoint})`);
  }
  return allowed;
}

/**
 * Check if a caller ID is allowed for inbound calls
 */
export function isInboundAllowed(callerId: string | undefined | null): boolean {
  const allowlist = getAllowlist();

  // If allowlist is empty, allow all (open mode)
  if (allowlist.inbound.length === 0) {
    return true;
  }

  const number = normalizeNumber(callerId);
  if (!number) {
    console.warn(`[Allowlist] Inbound call with no caller ID — blocked`);
    return false;
  }

  const allowed = allowlist.inbound.includes(number);
  if (!allowed) {
    console.warn(`[Allowlist] Inbound blocked: ${number}`);
  }
  return allowed;
}

/**
 * Reload the allowlist from disk
 */
export function reloadAllowlist(): Allowlist {
  return loadAllowlist(allowlistPath || undefined);
}
