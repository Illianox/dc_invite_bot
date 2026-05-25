export type InviteResolution =
  | { kind: "pending"; inviteCode: string; delta: number; consumedUses: Map<string, number> }
  | { kind: "non_referral" }
  | { kind: "unresolved"; reason: string };

export function resolveInviteChange(
  previous: Map<string, number>,
  current: Map<string, number>,
  managedCodes: Set<string>
): InviteResolution {
  if (previous.size === 0) {
    return { kind: "unresolved", reason: "No reliable invite baseline is available." };
  }

  const managedChanges: Array<{ code: string; delta: number }> = [];
  for (const code of managedCodes) {
    const before = previous.get(code);
    const after = current.get(code);
    if (before === undefined || after === undefined) {
      return { kind: "unresolved", reason: "A managed invite is missing from the snapshot." };
    }
    const delta = after - before;
    if (delta > 0) managedChanges.push({ code, delta });
  }

  if (managedChanges.length === 0) {
    return managedCodes.size > 0
      ? { kind: "unresolved", reason: "Kein verwalteter Invite-Link ist gestiegen, obwohl verwaltete Links vorhanden sind." }
      : { kind: "non_referral" };
  }
  if (managedChanges.length === 1) {
    const inviteCode = managedChanges[0]!.code;
    const consumedUses = new Map(current);
    consumedUses.set(inviteCode, previous.get(inviteCode)! + 1);
    return { kind: "pending", inviteCode, delta: managedChanges[0]!.delta, consumedUses };
  }
  return { kind: "unresolved", reason: "Die Invite-Nutzungen konnten nicht eindeutig zugeordnet werden." };
}
