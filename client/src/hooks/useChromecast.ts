import { useState, useEffect, useCallback, useRef } from "react";

/* ------------------------------------------------------------------ */
/*  TypeScript declarations for the Google Cast SDK (CAF)              */
/* ------------------------------------------------------------------ */

declare global {
  interface Window {
    __onGCastApiAvailable?: (isAvailable: boolean) => void;
    cast?: typeof cast;
    chrome?: { cast?: typeof chrome.cast };
  }
}

declare namespace cast {
  namespace framework {
    class CastContext {
      static getInstance(): CastContext;
      setOptions(options: {
        receiverApplicationId: string;
        autoJoinPolicy: string;
      }): void;
      requestSession(): Promise<void>;
      getCurrentSession(): CastSession | null;
      getCastState(): string;
      addEventListener(
        type: string,
        handler: (event: { castState: string }) => void,
      ): void;
      removeEventListener(
        type: string,
        handler: (event: { castState: string }) => void,
      ): void;
    }
    class CastSession {
      getSessionObj(): chrome.cast.Session;
      getMediaSession(): chrome.cast.media.Media | null;
      loadMedia(
        request: chrome.cast.media.LoadRequest,
      ): Promise<void>;
      endSession(stopCasting: boolean): void;
    }
    enum CastState {
      NO_DEVICES_AVAILABLE = "NO_DEVICES_AVAILABLE",
      NOT_CONNECTED = "NOT_CONNECTED",
      CONNECTING = "CONNECTING",
      CONNECTED = "CONNECTED",
    }
    enum CastContextEventType {
      CAST_STATE_CHANGED = "caststatechanged",
    }
    enum SessionEventType {
      MEDIA_SESSION = "MEDIA_SESSION",
    }
  }
}

declare namespace chrome.cast {
  class Session {
    displayName: string;
  }
  namespace media {
    class MediaInfo {
      constructor(contentId: string, contentType: string);
      contentId: string;
      contentType: string;
      metadata: GenericMediaMetadata | null;
      tracks: Track[] | null;
    }
    class Track {
      constructor(trackId: number, trackType: string);
      trackId: number;
      type: string;
      trackContentId: string;
      trackContentType: string;
      subtype: string;
      name: string;
      language: string;
    }
    class LoadRequest {
      constructor(mediaInfo: MediaInfo);
      autoplay: boolean;
      currentTime: number;
      activeTrackIds: number[];
    }
    class GenericMediaMetadata {
      title: string;
      images: Array<{ url: string }>;
    }
    class Media {
      playerState: string;
      media: MediaInfo | null;
      activeTrackIds: number[] | null;
      play(
        request: null,
        onSuccess: () => void,
        onError: () => void,
      ): void;
      pause(
        request: null,
        onSuccess: () => void,
        onError: () => void,
      ): void;
      stop(
        request: null,
        onSuccess: () => void,
        onError: () => void,
      ): void;
    }
    enum PlayerState {
      IDLE = "IDLE",
      PLAYING = "PLAYING",
      PAUSED = "PAUSED",
      BUFFERING = "BUFFERING",
    }
  }
  class AutoJoinPolicy {
    static ORIGIN_SCOPED: string;
  }
}

/* ------------------------------------------------------------------ */
/*  Captions                                                           */
/* ------------------------------------------------------------------ */

/**
 * The video's WebVTT sidecars as cast text tracks, in manifest order so a
 * track's index is the same one the in-page caption menu uses.
 *
 * The receiver has to be handed these explicitly. Left to itself it finds the
 * `mov_text` track embedded in the MP4 and lists it, but cannot draw it — a
 * caption that can be selected and never appears.
 */
/**
 * Where our caption track ids start. The receiver numbers the tracks it finds
 * inside the file (the MP4's own `mov_text` captions, its audio) from 1, so a
 * sidecar numbered from 1 can share an id with one of them — and selecting it
 * then turns on the embedded track the receiver cannot draw.
 */
const CAST_TRACK_ID_BASE = 1000;

async function loadCastTracks(url: string): Promise<chrome.cast.media.Track[]> {
  if (!url.includes("/external/")) return [];
  try {
    const res = await fetch(`${url}@subs.json`);
    if (!res.ok) return [];
    const json = (await res.json()) as {
      tracks?: Array<{ src?: unknown; label?: unknown; language?: unknown }>;
    };
    return (json.tracks ?? [])
      .filter((t) => t && typeof t.src === "string")
      .map((t, i) => {
        const track = new chrome.cast.media.Track(CAST_TRACK_ID_BASE + i, "TEXT");
        track.trackContentId = url + (t.src as string);
        track.trackContentType = "text/vtt";
        track.subtype = "SUBTITLES";
        if (typeof t.label === "string") track.name = t.label;
        // An empty or "und" tag is not BCP 47 and the receiver rejects it.
        if (typeof t.language === "string" && t.language && t.language !== "und") {
          track.language = t.language;
        }
        return track;
      });
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */

export type CastState = "unavailable" | "no_devices" | "available" | "connecting" | "connected";

const SDK_STATE_MAP: Record<string, CastState> = {
  NO_DEVICES_AVAILABLE: "no_devices",
  NOT_CONNECTED: "available",
  CONNECTING: "connecting",
  CONNECTED: "connected",
};

let sdkInitialised = false;
const sdkReadyCallbacks: Array<() => void> = [];

function ensureSdkInit() {
  if (sdkInitialised) return;

  const tryInit = () => {
    if (!window.cast?.framework) return false;
    const ctx = cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId:
        chrome.cast?.AutoJoinPolicy
          ? "CC1AD845" // Default Media Receiver
          : "CC1AD845",
      autoJoinPolicy: "ORIGIN_SCOPED",
    });
    sdkInitialised = true;
    for (const cb of sdkReadyCallbacks) cb();
    sdkReadyCallbacks.length = 0;
    return true;
  };

  if (tryInit()) return;

  // SDK not loaded yet — wait for the callback
  const prev = window.__onGCastApiAvailable;
  window.__onGCastApiAvailable = (isAvailable: boolean) => {
    prev?.(isAvailable);
    if (isAvailable) tryInit();
  };

  // Fallback: poll in case __onGCastApiAvailable already fired before we hooked it
  let attempts = 0;
  const poll = setInterval(() => {
    if (tryInit() || ++attempts > 50) clearInterval(poll);
  }, 200);
}

export function useChromecast() {
  const [castState, setCastState] = useState<CastState>("unavailable");
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const castingUrl = useRef<string | null>(null);

  useEffect(() => {
    ensureSdkInit();

    const update = () => {
      if (!window.cast?.framework) return;
      const ctx = cast.framework.CastContext.getInstance();
      const raw = ctx.getCastState();
      setCastState(SDK_STATE_MAP[raw] ?? "unavailable");

      const session = ctx.getCurrentSession();
      if (session) {
        setDeviceName(session.getSessionObj().displayName ?? null);
      } else {
        setDeviceName(null);
        castingUrl.current = null;
      }
    };

    if (sdkInitialised) {
      const ctx = cast.framework.CastContext.getInstance();
      ctx.addEventListener("caststatechanged", update);
      update();
      return () => ctx.removeEventListener("caststatechanged", update);
    }

    // SDK not ready yet — register for later
    const cb = () => {
      const ctx = cast.framework.CastContext.getInstance();
      ctx.addEventListener("caststatechanged", update);
      update();
    };
    sdkReadyCallbacks.push(cb);
    return () => {
      const idx = sdkReadyCallbacks.indexOf(cb);
      if (idx !== -1) sdkReadyCallbacks.splice(idx, 1);
    };
  }, []);

  const castVideo = useCallback(
    /** `captionTrack` is the index selected in the page's caption menu, null for off. */
    async (url: string, captionTrack: number | null = 0, title?: string, thumbnailUrl?: string) => {
      if (!window.cast?.framework || !window.chrome?.cast) return;
      const ctx = cast.framework.CastContext.getInstance();

      // If not connected, prompt for device selection first
      if (ctx.getCastState() !== "CONNECTED") {
        try {
          await ctx.requestSession();
        } catch {
          return; // User cancelled
        }
      }

      const session = ctx.getCurrentSession();
      if (!session) return;

      // Determine content type from URL extension
      const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "";
      const typeMap: Record<string, string> = {
        mp4: "video/mp4",
        webm: "video/webm",
        ogg: "video/ogg",
        mov: "video/mp4",
        mkv: "video/mp4", // served as remuxed mp4
      };
      const contentType = typeMap[ext] || "video/mp4";

      const mediaInfo = new chrome.cast.media.MediaInfo(url, contentType);
      const tracks = await loadCastTracks(url);
      if (tracks.length > 0) mediaInfo.tracks = tracks;
      if (title || thumbnailUrl) {
        const metadata = new chrome.cast.media.GenericMediaMetadata();
        if (title) metadata.title = title;
        if (thumbnailUrl) metadata.images = [{ url: thumbnailUrl }];
        mediaInfo.metadata = metadata;
      }

      const request = new chrome.cast.media.LoadRequest(mediaInfo);
      request.autoplay = true;
      request.currentTime = 0;
      const active = captionTrack === null ? undefined : tracks[captionTrack];
      request.activeTrackIds = active ? [active.trackId] : [];

      try {
        await session.loadMedia(request);
        castingUrl.current = url;
        if (tracks.length > 0) {
          // What the receiver made of the captions: the tracks it lists and
          // which are on. A sidecar it could not load shows up here as an
          // id missing from activeTrackIds.
          const media = session.getMediaSession();
          console.info("Cast captions", {
            sent: tracks.map((t) => ({ id: t.trackId, name: t.name, src: t.trackContentId })),
            requested: request.activeTrackIds,
            receiverTracks: media?.media?.tracks ?? null,
            receiverActive: media?.activeTrackIds ?? null,
          });
        }
      } catch (e) {
        console.error("Cast loadMedia failed:", e);
      }
    },
    [],
  );

  const stopCasting = useCallback(() => {
    if (!window.cast?.framework) return;
    const session =
      cast.framework.CastContext.getInstance().getCurrentSession();
    if (session) {
      session.endSession(true);
      castingUrl.current = null;
    }
  }, []);

  return {
    castState,
    deviceName,
    castVideo,
    stopCasting,
    isCasting: (url: string) => castingUrl.current === url,
  };
}
