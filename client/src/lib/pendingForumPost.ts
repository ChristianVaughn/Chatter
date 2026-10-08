/**
 * Opening a specific forum post from outside ForumArea.
 *
 * Which post is open is local state inside ForumArea, and that component may
 * not be mounted yet when navigation starts — selecting the room is what
 * mounts it. So the request is both parked here and announced on an event, and
 * whichever of the two the component reaches first wins: an already-mounted
 * ForumArea hears the event, a freshly mounted one collects the parked id.
 */
export const FORUM_POST_OPEN_EVENT = "forum.post.open";

/** `channelId` is the forum channel the post lives in, or null for a room
 *  that is a forum itself. Only that channel's view collects it. */
let pending: { roomId: string; channelId: string | null; postId: string } | null = null;

export function requestForumPost(roomId: string, postId: string, channelId: string | null = null): void {
  pending = { roomId, channelId, postId };
  window.dispatchEvent(
    new CustomEvent(FORUM_POST_OPEN_EVENT, { detail: { roomId, channelId, postId } }),
  );
}

/** Returns the parked post for this room and channel, if any, and clears it.
 *  Callers must take it even when they learned of it by event, or a later
 *  visit to the room would re-open the same post. */
export function takePendingForumPost(roomId: string | null, channelId: string | null = null): string | null {
  if (!roomId || pending?.roomId !== roomId || pending.channelId !== channelId) return null;
  const { postId } = pending;
  pending = null;
  return postId;
}
