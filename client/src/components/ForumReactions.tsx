import { useState } from "react";
import { SmilePlus } from "lucide-react";
import { useAppContext } from "@/lib/store";
import type { ForumPost } from "@/lib/api";
import { EmojiPicker } from "@/components/EmojiPicker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn, displayUserId } from "@/lib/utils";

function isCustomEmojiUrl(s: string) {
  return s.startsWith("/") || s.startsWith("http");
}

/**
 * A post's reactions and the button that adds one, shared by the card in the
 * list and the open post so the two cannot disagree.
 *
 * A post's id is its reaction key, so it rides the same machinery as a
 * message: the store's `messageReactions` is what the `m.reaction` broadcast
 * updates, and is read in preference to the reactions the post was fetched
 * with. Without that, a reaction reached only the person who made it.
 */
export function ForumReactions({ post, compact = false }: { post: ForumPost; compact?: boolean }) {
  const { state, dispatch, addReaction } = useAppContext();
  const [pickerOpen, setPickerOpen] = useState(false);
  const live = state.messageReactions[post.post_id];
  const reactions = live ?? post.reactions ?? {};
  const entries = Object.entries(reactions).filter(([, users]) => users.length > 0);

  const roomInfo = state.currentRoomId ? state.roomInfoMap[state.currentRoomId] : null;

  const toggle = (emoji: string) => {
    // The optimistic toggle starts from the store's entry; seed it with what
    // the post arrived carrying, or the first click would wipe the others.
    if (!live) {
      dispatch({ type: "SET_REACTIONS", payload: { eventId: post.post_id, reactions } });
    }
    addReaction(post.post_id, emoji);
  };

  return (
    // A card is one big button; nothing in here should open the post.
    <div className="flex flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {entries.map(([emoji, userIds]) => (
        <Tooltip key={emoji}>
          <TooltipTrigger asChild>
            <button
              onClick={() => toggle(emoji)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border transition-colors cursor-pointer",
                compact ? "px-1.5 py-0.5 text-3xs" : "px-2 py-0.5 text-xs",
                userIds.includes(state.userId ?? "")
                  ? "border-primary/50 bg-primary/10"
                  : "border-border hover:bg-accent",
              )}
            >
              {isCustomEmojiUrl(emoji) ? (
                <img
                  src={emoji}
                  alt="emoji"
                  className={cn("inline-block object-contain", compact ? "h-3 w-3" : "h-4 w-4")}
                />
              ) : (
                emoji
              )}
              <span className="text-muted-foreground font-medium">{userIds.length}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            {userIds.map((id) => (
              <p key={id}>{state.userPresence[id]?.displayName || displayUserId(id)}</p>
            ))}
          </TooltipContent>
        </Tooltip>
      ))}
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverTrigger asChild>
          <button
            title="Add reaction"
            aria-label="Add reaction"
            className={cn(
              "inline-flex items-center justify-center rounded-full border border-dashed border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer",
              compact ? "h-5 w-6" : "h-6 w-8",
            )}
          >
            <SmilePlus className={compact ? "h-3 w-3" : "h-3.5 w-3.5"} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <EmojiPicker
            onSelect={(emoji) => {
              toggle(emoji);
              setPickerOpen(false);
            }}
            roomCustomEmojis={roomInfo?.custom_emojis ?? []}
            emojiAliases={roomInfo?.emoji_aliases ?? {}}
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}
