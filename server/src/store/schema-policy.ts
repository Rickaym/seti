/**
 * Seti's own permission decisions counted beside the runtime's, per day and outcome: no input,
 * command, path or rule text, only kinds, steps and rule refs. A decision that failed counts with
 * result `failed` and empty facts.
 */
export const POLICY_SHADOW = `
CREATE TABLE policy_shadow (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  tool TEXT NOT NULL,
  mode TEXT NOT NULL,
  sandboxed BOOLEAN NOT NULL,
  slow BOOLEAN NOT NULL,
  verdict TEXT NOT NULL,
  step TEXT NOT NULL,
  rule TEXT NOT NULL,
  runtime TEXT NOT NULL,
  result TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, tool, mode, sandboxed, slow, verdict, step, rule, runtime, result)
);
`
