/**
 * TaskRabbit Authentication & Session Management
 *
 * Handles cookie persistence and login state detection.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { BrowserContext, Cookie } from "playwright";

const CONFIG_DIR = join(homedir(), ".config", "striderlabs-mcp-taskrabbit");
const COOKIES_FILE = join(CONFIG_DIR, "cookies.json");

export interface AuthState {
  isLoggedIn: boolean;
  email?: string;
  firstName?: string;
  lastName?: string;
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export async function saveCookies(context: BrowserContext): Promise<void> {
  ensureConfigDir();
  const cookies = await context.cookies();
  writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
}

export async function loadCookies(context: BrowserContext): Promise<boolean> {
  if (!existsSync(COOKIES_FILE)) {
    return false;
  }

  try {
    const cookiesData = readFileSync(COOKIES_FILE, "utf-8");
    const cookies: Cookie[] = JSON.parse(cookiesData);

    if (cookies.length > 0) {
      await context.addCookies(cookies);
      return true;
    }
  } catch (error) {
    console.error("Failed to load cookies:", error);
  }

  return false;
}

export function clearCookies(): void {
  if (existsSync(COOKIES_FILE)) {
    writeFileSync(COOKIES_FILE, "[]");
  }
}

export function hasStoredCookies(): boolean {
  if (!existsSync(COOKIES_FILE)) {
    return false;
  }

  try {
    const cookiesData = readFileSync(COOKIES_FILE, "utf-8");
    const cookies = JSON.parse(cookiesData);
    return Array.isArray(cookies) && cookies.length > 0;
  } catch {
    return false;
  }
}

export async function getAuthState(context: BrowserContext): Promise<AuthState> {
  const cookies = await context.cookies("https://www.taskrabbit.com");

  // TaskRabbit session cookies
  const hasSessionCookie = cookies.some(
    (c) =>
      c.name === "_taskrabbit_session" ||
      c.name === "tr_session" ||
      c.name === "remember_user_token" ||
      c.name === "user_credentials"
  );

  const userCookie = cookies.find(
    (c) => c.name === "current_user_id" || c.name === "tr_user_id"
  );

  if (hasSessionCookie || userCookie) {
    return {
      isLoggedIn: true,
    };
  }

  return {
    isLoggedIn: false,
  };
}

export function getCookiesPath(): string {
  return COOKIES_FILE;
}
