import { useSyncExternalStore } from "react";

const STORAGE_KEY = "chatter_favorite_gifs";
const CATEGORIES_KEY = "chatter_gif_categories";
export const MAX_CATEGORY_NAME = 32;

/**
 * A user-made folder of favourite GIFs. A GIF can sit in several, and every
 * GIF in one is also a favourite — unfavouriting takes it out of them all, so
 * a category can never hold something the Favorites list does not.
 */
export interface GifCategory {
  id: string;
  name: string;
  urls: string[];
}

interface FavoritesState {
  favorites: string[];
  categories: GifCategory[];
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function load(): FavoritesState {
  const favorites = readJson<unknown>(STORAGE_KEY, []);
  const categories = readJson<unknown>(CATEGORIES_KEY, []);
  const favs = Array.isArray(favorites) ? favorites.filter((u): u is string => typeof u === "string") : [];
  const favSet = new Set(favs);
  const cats = Array.isArray(categories)
    ? categories.flatMap((c): GifCategory[] => {
        if (!c || typeof c.id !== "string" || typeof c.name !== "string" || !Array.isArray(c.urls)) return [];
        return [{ id: c.id, name: c.name, urls: c.urls.filter((u: unknown): u is string => typeof u === "string" && favSet.has(u)) }];
      })
    : [];
  return { favorites: favs, categories: cats };
}

// One store for the whole page, so a star toggled on a message and the
// picker's Favorites tab can never disagree about what is favourited.
let state: FavoritesState = load();
const listeners = new Set<() => void>();

function commit(next: FavoritesState) {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next.favorites));
    localStorage.setItem(CATEGORIES_KEY, JSON.stringify(next.categories));
  } catch {
    // Storage full or blocked — the change still holds for this session.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Another tab changed them.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY && e.key !== CATEGORIES_KEY) return;
    state = load();
    listeners.forEach((l) => l());
  });
}

function addFavorite(url: string) {
  if (state.favorites.includes(url)) return;
  commit({ ...state, favorites: [url, ...state.favorites] });
}

function removeFavorite(url: string) {
  commit({
    favorites: state.favorites.filter((u) => u !== url),
    categories: state.categories.map((c) =>
      c.urls.includes(url) ? { ...c, urls: c.urls.filter((u) => u !== url) } : c
    ),
  });
}

function cleanName(name: string) {
  return name.trim().slice(0, MAX_CATEGORY_NAME);
}

/** Returns the new category's id, or null for an empty name. */
function createCategory(name: string): string | null {
  const clean = cleanName(name);
  if (!clean) return null;
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  commit({ ...state, categories: [...state.categories, { id, name: clean, urls: [] }] });
  return id;
}

function renameCategory(id: string, name: string) {
  const clean = cleanName(name);
  if (!clean) return;
  commit({ ...state, categories: state.categories.map((c) => (c.id === id ? { ...c, name: clean } : c)) });
}

/** Deletes the category only; its GIFs stay favourites. */
function deleteCategory(id: string) {
  commit({ ...state, categories: state.categories.filter((c) => c.id !== id) });
}

/** Puts a GIF in or takes it out of a category, favouriting it on the way in. */
function setInCategory(id: string, url: string, inCategory: boolean) {
  const favorites = inCategory && !state.favorites.includes(url) ? [url, ...state.favorites] : state.favorites;
  commit({
    favorites,
    categories: state.categories.map((c) => {
      if (c.id !== id) return c;
      const has = c.urls.includes(url);
      if (inCategory === has) return c;
      return { ...c, urls: inCategory ? [url, ...c.urls] : c.urls.filter((u) => u !== url) };
    }),
  });
}

export function useFavoriteGifs() {
  const { favorites, categories } = useSyncExternalStore(subscribe, () => state);
  return {
    favorites,
    categories,
    addFavorite,
    removeFavorite,
    isFavorite: (url: string) => favorites.includes(url),
    createCategory,
    renameCategory,
    deleteCategory,
    setInCategory,
  };
}

/** The same store outside React — for tests. */
export const favoriteGifStore = {
  get: () => state,
  addFavorite,
  removeFavorite,
  createCategory,
  renameCategory,
  deleteCategory,
  setInCategory,
};
