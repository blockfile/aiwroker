// Turn stored per-worker metrics into reward shares, per the Core formula:
//   CPU Score + Uptime Score + Task Score + Accuracy Score + Reputation Score
//     = Reward Share
//
// TASK (useful work actually done) is weighted highest, so a low-end PC still
// earns for the work it completes — "Core rewards useful work, not just device
// strength." Each score is normalized 0..1 relative to the current pool.
//
// IMPORTANT: Accuracy and Reputation are PLACEHOLDERS (default 1.0) until the
// verification layer exists. Do NOT pay real money based on these two yet — a
// worker can fake output to farm rewards until spot-checking/slashing is built.

const DEFAULT_WEIGHTS = { task: 1.0, uptime: 0.35, cpu: 0.15 };

const round = (n) => Math.round(Number(n) * 1000) / 1000;

export function computeRewards(workers, { weights } = {}) {
  const W = { ...DEFAULT_WEIGHTS, ...weights };
  const list = Array.isArray(workers) ? workers : [];

  const maxOf = (sel) => Math.max(1, ...list.map((w) => Number(sel(w)) || 0));
  const maxTokens = maxOf((w) => w.totalTokens);
  const maxSpeed = maxOf((w) => w.tokensPerSec);
  const maxUptime = maxOf((w) => w.uptimeSeconds);

  const scored = list.map((w) => {
    const task = (w.totalTokens || 0) / maxTokens;
    const uptime = (w.uptimeSeconds || 0) / maxUptime;
    const cpu = (w.tokensPerSec || 0) / maxSpeed;
    const accuracy = w.accuracyScore ?? 1; // placeholder until verification
    const reputation = w.reputationScore ?? 1; // placeholder until verification

    const composite = (W.task * task + W.uptime * uptime + W.cpu * cpu) * accuracy * reputation;

    return {
      key: w.key,
      name: w.name,
      models: w.models || [],
      totalJobs: w.totalJobs || 0,
      totalTokens: w.totalTokens || 0,
      uptimeHours: round((w.uptimeSeconds || 0) / 3600),
      tokensPerSec: round(w.tokensPerSec || 0),
      scores: {
        cpu: round(cpu),
        uptime: round(uptime),
        task: round(task),
        accuracy: round(accuracy),
        reputation: round(reputation),
      },
      composite,
    };
  });

  const total = scored.reduce((s, w) => s + w.composite, 0) || 1;

  return scored
    .map(({ composite, ...w }) => ({ ...w, share: round(composite / total) }))
    .sort((a, b) => b.share - a.share);
}
