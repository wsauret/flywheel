import {
  createSession as persistCreateSession,
  readSession,
  updateSession,
  listSessions,
  deleteSessionWithCompanions,
  type SessionListResult as PersistenceListResult,
} from "./persistence.js";
import type { Session } from "./schemas.js";
import { toBudgetLimits } from "../../workflows/schemas.js";
import { computeContextPercent } from "./budget-tracker-types.js";
import { isValidTransition, type SessionState } from "./state-machine.js";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../config/schema.js";
import { Log } from "../../infra/log.js";

const log = Log.create({ service: "session.manager" });

export interface SessionSummary {
  id: string;
  name: string;
  label: string;
  planPath?: string;
  state: SessionState;
  kind: "workflow" | "chat";
  command: string;
  totalCost: number;
  totalTokens: number;
  contextPercent: number;
  lastUpdated: string;
  createdAt?: string;
  repo?: string;
  branch?: string;
  claudeSessionId?: string;
}

export interface SessionListResult {
  sessions: SessionSummary[];
  errors: PersistenceListResult["errors"];
}

interface SessionManagerDeps {
  baseDir: string;
  config?: FlywheelConfig;
}

import type { SessionKind } from "./types.js";

export interface SessionManager {
  create(planPath: string, name?: string, kind?: SessionKind, initialState?: SessionState): string;
  list(): SessionListResult;
  updateState(id: string, newState: SessionState): void;
  updateLabel(id: string, label: string): void;
  delete(id: string): void;
  recoverStaleSessions(): number;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { baseDir } = deps;
  const config = deps.config ?? CONFIG_DEFAULTS;

  function readOrThrow(id: string) {
    const session = readSession(id, baseDir);
    if (session === null) {
      throw new Error(`Session not found: ${id}`);
    }
    return session;
  }

  function create(planPath: string, name?: string, kind?: SessionKind, initialState?: SessionState): string {
    const now = new Date().toISOString();
    const budget = config.budget;

    const state = initialState ?? "active";

    const sharedFields = {
      label: name ?? planPath,
      lastUpdated: now,
      state,
      name: name ?? "",
      createdAt: now,
      totalCost: 0,
      budgetLimits: toBudgetLimits(budget),
      budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0, context_prompt_tokens: 0, context_window: 0 },
    };

    const sessionData: Session = kind === "chat"
      ? { ...sharedFields, kind: "chat", command: "chat" } satisfies Session
      : { ...sharedFields, kind: "workflow", command: "work", planPath } satisfies Session;

    const id = persistCreateSession(sessionData, baseDir);

    return id;
  }

  function list(): SessionListResult {
    const raw = listSessions(baseDir);

    const sessions: SessionSummary[] = raw.sessions.map((entry) => {
      const state = entry.data.state;

      return {
        id: entry.id,
        name: entry.data.name,
        label: entry.data.label,
        planPath: entry.data.kind === "workflow" ? entry.data.planPath : undefined,
        state: state,
        kind: entry.data.kind,
        command: entry.data.command,
        totalCost: entry.data.totalCost || entry.data.budgetUsage?.cost_usd || 0,
        totalTokens: entry.data.budgetUsage?.tokens_used ?? 0,
        contextPercent: computeContextPercent(
          entry.data.budgetUsage?.context_prompt_tokens ?? 0,
          entry.data.budgetUsage?.context_window ?? 0,
        ),
        lastUpdated: entry.data.lastUpdated,
        createdAt: entry.data.createdAt,
        repo: entry.data.repo,
        branch: entry.data.branch,
        claudeSessionId: entry.data.kind === "chat" ? entry.data.claudeSessionId : undefined,
      };
    });

    return { sessions, errors: raw.errors };
  }

  function updateState(id: string, newState: SessionState): void {
    const persisted = readOrThrow(id);
    const currentState = persisted.state;

    if (currentState === newState) return;

    if (!isValidTransition(currentState, newState)) {
      throw new Error(
        `Invalid state transition: ${currentState} -> ${newState}`,
      );
    }

    updateSession(id, { state: newState }, baseDir);
  }

  function updateLabel(id: string, label: string): void {
    try {
      updateSession(id, { label, name: label }, baseDir);
    } catch {
      // Non-fatal — label update failure shouldn't crash anything
    }
  }

  function deleteSession(id: string): void {
    deleteSessionWithCompanions(id, baseDir);
  }

  function recoverStaleSessions(): number {
    const { sessions } = listSessions(baseDir);
    let recovered = 0;

    for (const entry of sessions) {
      const state = entry.data.state;

      // Only active sessions with no running queue need recovery
      if (state !== "active") continue;

      try {
        updateState(entry.id, "paused");
        log.info("recovered stale session", { session: entry.data.name || entry.id, to: "paused" });
        recovered++;
      } catch {
        // Non-fatal — skip sessions that fail to update
      }
    }

    return recovered;
  }

  return {
    create,
    list,
    updateState,
    updateLabel,
    delete: deleteSession,
    recoverStaleSessions,
  };
}
