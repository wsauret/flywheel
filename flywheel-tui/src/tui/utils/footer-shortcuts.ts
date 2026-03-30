/**
 * Footer Shortcuts — pure logic for resolving keyboard shortcut text.
 *
 * Separated from the StatusFooter component for testability.
 * Adapts shortcut text based on app state and interaction context.
 */

import type { AppState } from "../components/shell-modes";

export interface FooterContext {
  appState: AppState;
  approvalPending?: boolean;
  isPromptFocused?: boolean;
  sidebarFocused?: boolean;
  sidebarVisible?: boolean;
  isSessionResumable?: boolean;
  isWorking?: boolean;
  /** Whether the worker is in an interrupted state (first Esc, awaiting resume). */
  isInterrupted?: boolean;
}

/**
 * Resolve the keyboard shortcut text based on current context.
 *
 * Priority (highest → lowest):
 * 1. Sidebar focused → sidebar navigation shortcuts
 * 2. Prompt focused → prompt editing shortcuts
 * 3. Working + approval pending → approval shortcuts
 * 4. Working → queue execution shortcuts
 * 5. Idle/completed → standard shortcuts
 */
export function resolveFooterShortcuts(ctx: FooterContext): string {
  // Sidebar focused always takes precedence
  if (ctx.sidebarFocused) {
    return "[↑↓] Navigate  [Enter] Select  [Del] Delete  [Esc/Tab] Exit Sidebar";
  }

  // Prompt focused
  if (ctx.isPromptFocused) {
    return "[Tab] Focus Output  [Esc] Exit Prompt  [Enter] Continue/Send  [Ctrl+S] Skip  [Ctrl+D] Raw";
  }

  const sidebarHint = ctx.sidebarVisible ? "[Tab] Sidebar  " : "";
  const isWorking = ctx.appState === "working" || ctx.isWorking;
  const bgHint = isWorking ? "[Ctrl+B] Background  " : "";

  // Interrupted state: show resume hint
  if (isWorking && ctx.isInterrupted) {
    return `[Type] Resume worker  [Esc] Kill worker  ${sidebarHint}`;
  }

  // Working state with approval pending
  if (isWorking && ctx.approvalPending) {
    return `[Right] Focus Prompt  ${sidebarHint}${bgHint}[↑↓] Navigate  [Ctrl+D] Raw  [Esc] Stop`;
  }

  // Working state — queue execution shortcuts
  if (isWorking) {
    return `${sidebarHint}${bgHint}[↑↓] Navigate  [Ctrl+D] Raw  [Esc] Stop`;
  }

  // Idle / completed — standard shortcuts
  const resumeHint = ctx.isSessionResumable ? "[Ctrl+R] Resume  " : "";
  return `${resumeHint}${sidebarHint}[↑↓] Navigate  [Ctrl+D] Raw  [Esc] Exit`;
}
