import type { AppState } from "@/lib/store/types";

export interface MentionMatch {
  kind: "user" | "role";
  id: string;
  name: string;
  color: string | undefined;
}

/** Members and roles whose name starts with what follows the "@". Shared by
 *  the channel and thread composers so the two cannot offer different lists. */
export function findMentionMatches(state: AppState, search: string): MentionMatch[] {
  const needle = search.toLowerCase();
  const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : null;
  const builtInRoles: MentionMatch[] = [];
  for (const r of [{ name: "owner", color: roomInfo?.owner_name_color }, { name: "moderator", color: roomInfo?.mod_name_color }]) {
    if (r.name.startsWith(needle)) {
      builtInRoles.push({ kind: "role", id: `builtin-${r.name}`, name: r.name, color: r.color || undefined });
    }
  }
  return [
    ...state.roomMembers
      .filter((m) => m.displayName.toLowerCase().startsWith(needle))
      .slice(0, 5)
      .map((m): MentionMatch => ({ kind: "user", id: m.userId, name: m.displayName, color: undefined })),
    ...builtInRoles,
    ...state.customRoles
      .filter((r) => r.name.toLowerCase().startsWith(needle))
      .slice(0, 5)
      .map((r): MentionMatch => ({ kind: "role", id: r.role_id, name: r.name, color: r.color || undefined })),
  ].slice(0, 8);
}
