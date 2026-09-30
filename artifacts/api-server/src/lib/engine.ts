/**
 * Pure team-qualification and incentive logic. No database access here so
 * the rules can be verified independently against test cases
 * (see scripts/src/engine.test.ts).
 *
 * Structure: Manager → Team Leader → Reseller → Customer. Incentives are
 * only ever calculated on product sales — never on recruitment, joining or
 * registration.
 */

export const RANKS = ["reseller", "team_leader", "manager", "director"] as const;
export type Rank = (typeof RANKS)[number];

export const RANK_LABELS: Record<string, string> = {
  reseller: "Reseller",
  team_leader: "Team Leader",
  manager: "Manager",
  director: "Director",
};

export const rankValue = (rank: string) => Math.max(0, RANKS.indexOf(rank as Rank));

export type EngineSettings = {
  teamLeaderRate: number;
  managerRate: number;
  directorRate: number;
  directorEnabled: boolean;
  personalTarget: number;
  teamTarget: number;
  tlActiveDirects: number;
  mgrActiveTeamLeaders: number;
  mgrActiveResellers: number;
  mgrOrgBottles: number;
  mgrPersonalBottles: number;
  dirActiveManagers: number;
  dirActiveResellers: number;
  dirOrgBottles: number;
  activeMinBottles: number;
  reactivationBottles: number;
  rankGraceMonths: number;
};

export type NetworkMember = {
  id: number;
  sponsorId: number | null;
  rank: string;
  rankLocked: boolean;
  rankWarningMonths: number;
  standing: string;
  /** Whether the reseller was active in the previous period. */
  wasActive: boolean;
};

export type Volume = { bottles: number; sales: number };

export type MemberStats = {
  personalBottles: number;
  personalSales: number;
  teamBottles: number;
  teamSales: number;
  orgBottles: number;
  orgSales: number;
  activeDirects: number;
  inactiveDirects: number;
  activeTeamLeaders: number;
  activeManagers: number;
  orgActiveResellers: number;
  isActive: boolean;
  qualifiesTeamLeader: boolean;
  qualifiesManager: boolean;
  qualifiesDirector: boolean;
  qualifiedRank: Rank;
};

/** Children lists plus a bottom-up (post-order) traversal that tolerates bad data (cycles, orphans). */
function buildTree(members: NetworkMember[]) {
  const byId = new Map(members.map((m) => [m.id, m]));
  const children = new Map<number, number[]>();
  const roots: number[] = [];
  for (const m of members) {
    if (m.sponsorId != null && byId.has(m.sponsorId) && m.sponsorId !== m.id) {
      const list = children.get(m.sponsorId) ?? [];
      list.push(m.id);
      children.set(m.sponsorId, list);
    } else {
      roots.push(m.id);
    }
  }
  const order: number[] = [];
  const visited = new Set<number>();
  const visit = (start: number) => {
    const stack: Array<[number, boolean]> = [[start, false]];
    while (stack.length) {
      const [id, expanded] = stack.pop()!;
      if (expanded) {
        order.push(id);
        continue;
      }
      if (visited.has(id)) continue;
      visited.add(id);
      stack.push([id, true]);
      for (const child of children.get(id) ?? []) stack.push([child, false]);
    }
  };
  roots.forEach(visit);
  // Members caught in a sponsor cycle are unreachable from a root.
  for (const m of members) if (!visited.has(m.id)) visit(m.id);
  return { byId, children, order };
}

export function evaluateNetwork(
  members: NetworkMember[],
  volumes: Map<number, Volume>,
  s: EngineSettings,
): Map<number, MemberStats> {
  const { byId, children, order } = buildTree(members);
  const stats = new Map<number, MemberStats>();

  for (const id of order) {
    const member = byId.get(id)!;
    const own = volumes.get(id) ?? { bottles: 0, sales: 0 };
    const threshold = member.wasActive ? s.activeMinBottles : s.reactivationBottles;
    const isActive = member.standing !== "suspended" && own.bottles >= Math.max(1, threshold);
    const kids = (children.get(id) ?? []).map((k) => stats.get(k)!).filter(Boolean);

    const teamBottles = kids.reduce((sum, k) => sum + k.personalBottles, 0);
    const teamSales = kids.reduce((sum, k) => sum + k.personalSales, 0);
    const orgBottles = own.bottles + kids.reduce((sum, k) => sum + k.orgBottles, 0);
    const orgSales = own.sales + kids.reduce((sum, k) => sum + k.orgSales, 0);
    const activeDirects = kids.filter((k) => k.isActive).length;
    const orgActiveResellers = kids.reduce((sum, k) => sum + k.orgActiveResellers + (k.isActive ? 1 : 0), 0);
    const activeTeamLeaders = kids.filter((k) => rankValue(k.qualifiedRank) >= 1).length;
    const activeManagers = kids.filter((k) => rankValue(k.qualifiedRank) >= 2).length;
    const goodStanding = member.standing === "good";

    const qualifiesTeamLeader =
      goodStanding &&
      isActive &&
      activeDirects >= s.tlActiveDirects &&
      own.bottles >= s.personalTarget &&
      teamBottles >= s.teamTarget;
    const qualifiesManager =
      goodStanding &&
      isActive &&
      activeTeamLeaders >= s.mgrActiveTeamLeaders &&
      orgActiveResellers >= s.mgrActiveResellers &&
      orgBottles >= s.mgrOrgBottles &&
      own.bottles >= s.mgrPersonalBottles;
    const qualifiesDirector =
      s.directorEnabled &&
      goodStanding &&
      isActive &&
      activeManagers >= s.dirActiveManagers &&
      orgActiveResellers >= s.dirActiveResellers &&
      orgBottles >= s.dirOrgBottles;

    stats.set(id, {
      personalBottles: own.bottles,
      personalSales: own.sales,
      teamBottles,
      teamSales,
      orgBottles,
      orgSales,
      activeDirects,
      inactiveDirects: kids.length - activeDirects,
      activeTeamLeaders,
      activeManagers,
      orgActiveResellers,
      isActive,
      qualifiesTeamLeader,
      qualifiesManager,
      qualifiesDirector,
      qualifiedRank: qualifiesDirector
        ? "director"
        : qualifiesManager
          ? "manager"
          : qualifiesTeamLeader
            ? "team_leader"
            : "reseller",
    });
  }
  return stats;
}

export type RankDecision = {
  rankAfter: string;
  warningMonths: number;
  warning: boolean;
  change: "promotion" | "demotion" | "none";
};

/**
 * Leaders who miss their requirements get `rankGraceMonths` warning
 * ("coaching") months, then revert to the rank they actually qualified for.
 * They keep their reseller account and can re-qualify at any time.
 */
export function decideRank(
  member: Pick<NetworkMember, "rank" | "rankLocked" | "rankWarningMonths">,
  qualifiedRank: string,
  graceMonths: number,
): RankDecision {
  if (member.rankLocked) {
    return { rankAfter: member.rank, warningMonths: 0, warning: false, change: "none" };
  }
  const current = rankValue(member.rank);
  const qualified = rankValue(qualifiedRank);
  if (qualified > current) {
    return { rankAfter: qualifiedRank, warningMonths: 0, warning: false, change: "promotion" };
  }
  if (qualified === current) {
    return { rankAfter: member.rank, warningMonths: 0, warning: false, change: "none" };
  }
  const months = member.rankWarningMonths + 1;
  if (months > graceMonths) {
    return { rankAfter: qualifiedRank, warningMonths: 0, warning: false, change: "demotion" };
  }
  return { rankAfter: member.rank, warningMonths: months, warning: true, change: "none" };
}

export type IncentiveKind = "team_leader" | "manager" | "director" | "referral";

export type IncentiveTarget = {
  beneficiaryId: number;
  kind: IncentiveKind;
  rate: number;
  rank: string;
};

export type IncentiveContext = {
  parentOf: (id: number) => number | null;
  rankOf: (id: number) => string;
  /** Whether the reseller may receive leadership incentives. */
  eligible: (id: number) => boolean;
  settings: Pick<EngineSettings, "teamLeaderRate" | "managerRate" | "directorRate" | "directorEnabled">;
};

/**
 * Who earns what on a qualifying sale made by `sellerId`:
 *  - Team Leader  (5%): the seller's direct sponsor, if Team Leader or above.
 *  - Manager      (2%): the direct upline of the Team Leader whose team made
 *                       the sale (the seller if they are a TL, else the TL
 *                       sponsor), if Manager or above.
 *  - Director     (1%): the direct upline of the nearest Manager in the
 *                       chain, if Director and the level is enabled.
 */
export function incentiveTargets(sellerId: number, ctx: IncentiveContext): IncentiveTarget[] {
  const { parentOf, rankOf, eligible, settings } = ctx;
  const targets: IncentiveTarget[] = [];
  const push = (beneficiaryId: number | null, kind: IncentiveKind, rate: number) => {
    if (beneficiaryId == null || beneficiaryId === sellerId || rate <= 0 || !eligible(beneficiaryId)) return;
    targets.push({ beneficiaryId, kind, rate, rank: rankOf(beneficiaryId) });
  };

  const sponsor = parentOf(sellerId);
  if (sponsor != null && rankValue(rankOf(sponsor)) >= 1) {
    push(sponsor, "team_leader", settings.teamLeaderRate);
  }

  const teamLeader =
    rankValue(rankOf(sellerId)) >= 1
      ? sellerId
      : sponsor != null && rankValue(rankOf(sponsor)) >= 1
        ? sponsor
        : null;
  if (teamLeader != null) {
    const manager = parentOf(teamLeader);
    if (manager != null && rankValue(rankOf(manager)) >= 2) push(manager, "manager", settings.managerRate);
  }

  if (settings.directorEnabled) {
    let cursor: number | null = sellerId;
    const seen = new Set<number>();
    while (cursor != null && !seen.has(cursor) && rankValue(rankOf(cursor)) < 2) {
      seen.add(cursor);
      cursor = parentOf(cursor);
    }
    const director = cursor != null ? parentOf(cursor) : null;
    if (director != null && rankValue(rankOf(director)) >= 3) push(director, "director", settings.directorRate);
  }

  return targets;
}

export const incentiveAmount = (base: number, rate: number) => Math.round(base * rate) / 100;

/** Progress (0–100) across a set of requirements, each capped at 100%. */
export function requirementProgress(reqs: Array<{ current: number; target: number }>) {
  if (!reqs.length) return 100;
  const total = reqs.reduce((sum, r) => sum + (r.target <= 0 ? 1 : Math.min(1, r.current / r.target)), 0);
  return Math.round((total / reqs.length) * 100);
}
