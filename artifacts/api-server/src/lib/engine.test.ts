import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRank,
  evaluateNetwork,
  incentiveAmount,
  incentiveTargets,
  requirementProgress,
  type EngineSettings,
  type NetworkMember,
  type Volume,
} from "./engine";

/** Defaults from the proposal: 5% / 2% / 1%, TL 5 directs · 20 personal · 100 team, etc. */
const SETTINGS: EngineSettings = {
  teamLeaderRate: 5,
  managerRate: 2,
  directorRate: 1,
  directorEnabled: false,
  personalTarget: 20,
  teamTarget: 100,
  tlActiveDirects: 5,
  mgrActiveTeamLeaders: 3,
  mgrActiveResellers: 15,
  mgrOrgBottles: 300,
  mgrPersonalBottles: 20,
  dirActiveManagers: 5,
  dirActiveResellers: 50,
  dirOrgBottles: 1000,
  activeMinBottles: 1,
  reactivationBottles: 10,
  rankGraceMonths: 1,
};

const member = (id: number, sponsorId: number | null, rank = "reseller", extra: Partial<NetworkMember> = {}): NetworkMember => ({
  id,
  sponsorId,
  rank,
  rankLocked: false,
  rankWarningMonths: 0,
  standing: "good",
  wasActive: true,
  ...extra,
});

const vol = (bottles: number, unit = 140): Volume => ({ bottles, sales: bottles * unit });

/** Manager 1 → TLs 2,3,4 → five resellers each (ids 10..24), everyone selling 20 bottles. */
function acceptanceNetwork() {
  const members = [member(1, null, "manager"), member(2, 1, "team_leader"), member(3, 1, "team_leader"), member(4, 1, "team_leader")];
  const volumes = new Map<number, Volume>([[1, vol(20)], [2, vol(20)], [3, vol(20)], [4, vol(20)]]);
  let id = 10;
  for (const tl of [2, 3, 4]) {
    for (let i = 0; i < 5; i++, id++) {
      members.push(member(id, tl));
      volumes.set(id, vol(20));
    }
  }
  return { members, volumes };
}

test("proposal example: 100 bottles × R140 at 5% = R700 Team Leader incentive", () => {
  assert.equal(incentiveAmount(100 * 140, SETTINGS.teamLeaderRate), 700);
});

test("Team Leader qualifies with 5 active directs, 20 personal and 100 team bottles", () => {
  const { members, volumes } = acceptanceNetwork();
  const stats = evaluateNetwork(members, volumes, SETTINGS);
  const tl = stats.get(2)!;
  assert.equal(tl.activeDirects, 5);
  assert.equal(tl.teamBottles, 100);
  assert.equal(tl.teamSales, 14000);
  assert.equal(tl.qualifiedRank, "team_leader");
});

test("Manager qualifies with 3 TLs, 15+ active resellers, 300+ org bottles, 20 personal", () => {
  const { members, volumes } = acceptanceNetwork();
  const m = evaluateNetwork(members, volumes, SETTINGS).get(1)!;
  assert.equal(m.activeTeamLeaders, 3);
  assert.equal(m.orgActiveResellers, 18);
  assert.equal(m.orgBottles, 380);
  assert.equal(m.qualifiedRank, "manager");
});

test("Team Leader does not qualify at 99 team bottles or with 4 active directs", () => {
  const { members, volumes } = acceptanceNetwork();
  volumes.set(10, vol(19));
  assert.equal(evaluateNetwork(members, volumes, SETTINGS).get(2)!.qualifiedRank, "reseller");
  const again = acceptanceNetwork();
  again.volumes.set(10, vol(0));
  again.volumes.set(11, vol(40));
  const tl = evaluateNetwork(again.members, again.volumes, SETTINGS).get(2)!;
  assert.equal(tl.teamBottles, 100);
  assert.equal(tl.activeDirects, 4);
  assert.equal(tl.qualifiedRank, "reseller");
});

test("incentive targets: reseller sale pays 5% to the TL sponsor and 2% to the TL's manager", () => {
  const { members } = acceptanceNetwork();
  const byId = new Map(members.map((m) => [m.id, m]));
  const ctx = {
    parentOf: (id: number) => byId.get(id)?.sponsorId ?? null,
    rankOf: (id: number) => byId.get(id)?.rank ?? "reseller",
    eligible: () => true,
    settings: SETTINGS,
  };
  assert.deepEqual(
    incentiveTargets(10, ctx).map((t) => [t.beneficiaryId, t.kind, t.rate]),
    [[2, "team_leader", 5], [1, "manager", 2]],
  );
  // A TL's own sale: the manager earns both as direct sponsor (5%) and as manager (2%).
  assert.deepEqual(
    incentiveTargets(2, ctx).map((t) => [t.beneficiaryId, t.kind, t.rate]),
    [[1, "team_leader", 5], [1, "manager", 2]],
  );
  // The manager's own sale earns nobody anything (no upline).
  assert.deepEqual(incentiveTargets(1, ctx), []);
});

test("acceptance totals: TL R700, Manager 2% = R1,008 plus 5% on direct TLs = R420", () => {
  const { members, volumes } = acceptanceNetwork();
  const byId = new Map(members.map((m) => [m.id, m]));
  const ctx = {
    parentOf: (id: number) => byId.get(id)?.sponsorId ?? null,
    rankOf: (id: number) => byId.get(id)?.rank ?? "reseller",
    eligible: () => true,
    settings: SETTINGS,
  };
  const earned = new Map<string, number>();
  for (const [seller, v] of volumes) {
    for (const t of incentiveTargets(seller, ctx)) {
      const key = `${t.beneficiaryId}:${t.kind}`;
      earned.set(key, (earned.get(key) ?? 0) + incentiveAmount(v.sales, t.rate));
    }
  }
  assert.equal(earned.get("2:team_leader"), 700);
  assert.equal(earned.get("1:manager"), 1008);
  assert.equal(earned.get("1:team_leader"), 420);
});

test("no incentives flow to ineligible (suspended/inactive) beneficiaries or from recruitment", () => {
  const members = [member(1, null, "team_leader"), member(2, 1)];
  const byId = new Map(members.map((m) => [m.id, m]));
  const ctx = {
    parentOf: (id: number) => byId.get(id)?.sponsorId ?? null,
    rankOf: (id: number) => byId.get(id)?.rank ?? "reseller",
    eligible: (id: number) => id !== 1,
    settings: SETTINGS,
  };
  assert.deepEqual(incentiveTargets(2, ctx), []);
  // Recruiting alone creates no volume and therefore nothing to calculate on.
  const stats = evaluateNetwork(members, new Map(), SETTINGS);
  assert.equal(stats.get(1)!.teamSales, 0);
});

test("a plain reseller sponsor earns no team incentive", () => {
  const members = [member(1, null, "reseller"), member(2, 1)];
  const byId = new Map(members.map((m) => [m.id, m]));
  const targets = incentiveTargets(2, {
    parentOf: (id) => byId.get(id)?.sponsorId ?? null,
    rankOf: (id) => byId.get(id)?.rank ?? "reseller",
    eligible: () => true,
    settings: SETTINGS,
  });
  assert.deepEqual(targets, []);
});

test("director level only pays when enabled", () => {
  const members = [member(1, null, "director"), member(2, 1, "manager"), member(3, 2, "team_leader"), member(4, 3)];
  const byId = new Map(members.map((m) => [m.id, m]));
  const base = { parentOf: (id: number) => byId.get(id)?.sponsorId ?? null, rankOf: (id: number) => byId.get(id)?.rank ?? "reseller", eligible: () => true };
  assert.ok(!incentiveTargets(4, { ...base, settings: SETTINGS }).some((t) => t.kind === "director"));
  const on = incentiveTargets(4, { ...base, settings: { ...SETTINGS, directorEnabled: true } });
  assert.deepEqual(on.map((t) => [t.beneficiaryId, t.kind, t.rate]), [[3, "team_leader", 5], [2, "manager", 2], [1, "director", 1]]);
});

test("inactivity: 0 bottles is inactive; reactivation needs 10 bottles in a month", () => {
  const members = [member(1, null, "reseller", { wasActive: true }), member(2, null, "reseller", { wasActive: false }), member(3, null, "reseller", { wasActive: false })];
  const stats = evaluateNetwork(members, new Map([[1, vol(0)], [2, vol(9)], [3, vol(10)]]), SETTINGS);
  assert.equal(stats.get(1)!.isActive, false);
  assert.equal(stats.get(2)!.isActive, false);
  assert.equal(stats.get(3)!.isActive, true);
});

test("Team Leader inactivity: month 1 warning, month 2 reverts to Reseller, then can re-qualify", () => {
  const month1 = decideRank({ rank: "team_leader", rankLocked: false, rankWarningMonths: 0 }, "reseller", 1);
  assert.deepEqual(month1, { rankAfter: "team_leader", warningMonths: 1, warning: true, change: "none" });
  const month2 = decideRank({ rank: "team_leader", rankLocked: false, rankWarningMonths: 1 }, "reseller", 1);
  assert.deepEqual(month2, { rankAfter: "reseller", warningMonths: 0, warning: false, change: "demotion" });
  const back = decideRank({ rank: "reseller", rankLocked: false, rankWarningMonths: 0 }, "team_leader", 1);
  assert.equal(back.change, "promotion");
  const recovered = decideRank({ rank: "team_leader", rankLocked: false, rankWarningMonths: 1 }, "team_leader", 1);
  assert.deepEqual(recovered, { rankAfter: "team_leader", warningMonths: 0, warning: false, change: "none" });
});

test("locked ranks are never changed by the monthly run", () => {
  assert.equal(decideRank({ rank: "manager", rankLocked: true, rankWarningMonths: 5 }, "reseller", 1).rankAfter, "manager");
});

test("suspended or non-good standing cannot qualify for leadership", () => {
  const { members, volumes } = acceptanceNetwork();
  members.find((m) => m.id === 2)!.standing = "hold";
  assert.equal(evaluateNetwork(members, volumes, SETTINGS).get(2)!.qualifiedRank, "reseller");
});

test("sponsor cycles in bad data do not hang the evaluation", () => {
  const members = [member(1, 2), member(2, 1)];
  const stats = evaluateNetwork(members, new Map([[1, vol(5)], [2, vol(5)]]), SETTINGS);
  assert.equal(stats.size, 2);
});

test("requirement progress caps each requirement at 100%", () => {
  assert.equal(requirementProgress([{ current: 10, target: 5 }, { current: 0, target: 20 }]), 50);
  assert.equal(requirementProgress([]), 100);
});

test("percentages are configurable, not hard-coded", () => {
  const members = [member(1, null, "team_leader"), member(2, 1)];
  const byId = new Map(members.map((m) => [m.id, m]));
  const [t] = incentiveTargets(2, {
    parentOf: (id) => byId.get(id)?.sponsorId ?? null,
    rankOf: (id) => byId.get(id)?.rank ?? "reseller",
    eligible: () => true,
    settings: { ...SETTINGS, teamLeaderRate: 7.5 },
  });
  assert.equal(incentiveAmount(14000, t!.rate), 1050);
});
