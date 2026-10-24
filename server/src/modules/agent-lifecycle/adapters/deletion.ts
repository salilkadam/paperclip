import { agents, costEvents, financeEvents, type Db } from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { conflict } from "../../../errors.js";
import { isForeignKeyViolation } from "../../../db-errors.js";
import { agentRecordQueries } from "../../../lib/agent-records.js";
import { readBuiltInAgentMarker } from "../../../lib/built-in-agent-metadata.js";
import { assertAgentPurgeAllowed } from "../domain/policy.js";
import type { LifecycleEffects } from "./effects.js";

export async function purgeAgent(db: Db, effects: LifecycleEffects, id: string) {
  const { getById, normalizeAgentRow } = agentRecordQueries(db);
  const existing = await getById(id);
  if (!existing) return null;
  return effects.transaction(db, existing.companyId, async tx => {
    const [agent] = await tx.select().from(agents).where(eq(agents.id, id)).for("update");
    if (!agent) return null;
    const marker = readBuiltInAgentMarker(agent.metadata);
    if (marker) throw conflict("Built-in agents cannot be deleted; pause them instead", {
      code: "built_in_agent_undeletable", key: marker.key, featureKeys: marker.featureKeys,
    });
    assertAgentPurgeAllowed(agent);
    // Spend records are the company's budget and finance history. Deleting
    // an agent must never erase or orphan them, so an agent that has spent
    // stays terminated (which keeps its history) instead of being deleted.
    const [costSpend] = await tx.select({ id: costEvents.id }).from(costEvents)
      .where(eq(costEvents.agentId, id)).limit(1);
    const [financeSpend] = costSpend ? [] : await tx.select({ id: financeEvents.id }).from(financeEvents)
      .where(eq(financeEvents.agentId, id)).limit(1);
    if (costSpend || financeSpend) {
      throw conflict("This agent has recorded spend, so it cannot be deleted. Keep it terminated to preserve its history.", {
        code: "agent_has_spend_history",
      });
    }
    await effects.deleteDependencies(tx, agent.companyId, id);
    const [deleted] = await tx.delete(agents).where(and(
      eq(agents.id, id), inArray(agents.lifecycleState, ["terminated", "rejected"]),
    )).returning();
    return deleted ? normalizeAgentRow(deleted) : null;
  }).catch((err) => {
    // Other durable records (decisions, browser sessions, ...) can still
    // reference this agent's runs. Report that as a conflict the board can
    // act on, not an internal error.
    if (isForeignKeyViolation(err)) {
      throw conflict("This agent has history that other records still reference, so it cannot be deleted. Keep it terminated instead.", {
        code: "agent_has_referenced_history",
      });
    }
    throw err;
  });
}
