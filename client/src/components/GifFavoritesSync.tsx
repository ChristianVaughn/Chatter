import { useEffect } from "react";
import { useAppState } from "@/lib/store";
import { loadGifFavorites, resetGifFavorites } from "@/hooks/useFavoriteGifs";

/**
 * Keeps favourite GIFs in step with the account, so a GIF favourited or filed
 * on one device is there on the next.
 *
 * Renders nothing. Changes made elsewhere arrive live as a `gif_favorites`
 * socket message; this covers the moments the socket cannot — signing in, and
 * coming back to a tab whose socket may have been down while they happened.
 */
export function GifFavoritesSync() {
  const { accessToken, userId } = useAppState();

  useEffect(() => {
    resetGifFavorites();
    if (!accessToken || !userId) return;
    void loadGifFavorites();
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadGifFavorites();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
    // The token refreshes under a signed-in user; only a change of user is a
    // different set of favourites.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, !!accessToken]);

  return null;
}
