// Which media stack voice runs on. In a browser it is always the browser's.
// The desktop app can offer a native engine (feature "voice-backend@1"); it is
// used unless the person has switched it off in Voice & Audio settings.

import { desktop, hasDesktopFeature } from "@/lib/desktop/bridge";
import { browserVoiceBackend } from "./browserVoice";
import type { VoiceMediaBackend } from "./types";

export type * from "./types";
export { browserVoiceBackend } from "./browserVoice";

const NATIVE_VOICE_KEY = "chatter_native_voice";

export function nativeVoiceAvailable(): boolean {
  return hasDesktopFeature("voice-backend@1") && typeof desktop?.voiceBackend === "function";
}

export function nativeVoicePreferred(): boolean {
  try {
    return localStorage.getItem(NATIVE_VOICE_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setNativeVoicePreferred(on: boolean): void {
  try {
    localStorage.setItem(NATIVE_VOICE_KEY, on ? "on" : "off");
  } catch {
    // Only costs remembering the choice.
  }
}

/** Chosen once per join, so a call never switches stacks underneath itself. */
export function selectVoiceBackend(): VoiceMediaBackend {
  if (nativeVoiceAvailable() && nativeVoicePreferred()) {
    try {
      const native = desktop!.voiceBackend!(1) as VoiceMediaBackend | null;
      if (native) return native;
    } catch {
      // An engine that can't start leaves voice on the browser.
    }
  }
  return browserVoiceBackend;
}
