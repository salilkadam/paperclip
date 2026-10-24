import { isUniqueViolation } from "../../db-errors.js";

// A claim that violates the partial unique index issues_open_routine_execution_uq
// means another open issue already holds the routine execution's single open
// execution slot. The conflict clears once that issue settles, so the claim is
// deferrable (same contract as isDeferrableClaimRejection): the run stays
// queued and the rest of the queue — and startup recovery — must keep going.
// Drizzle wraps Postgres errors in DrizzleQueryError with the PostgresError as
// `cause`. postgres.js names the constraint `constraint_name` (node-postgres:
// `constraint`) and only the cause's message mentions it, so walk the cause
// chain with the shared helper. Checking `cause.constraint` and the outer
// "Failed query: ..." message missed the postgres.js shape, which let this
// conflict escape startup recovery and exit the server.
export function isRoutineExecutionSlotConflict(err: unknown): boolean {
  return isUniqueViolation(err, "issues_open_routine_execution_uq");
}
