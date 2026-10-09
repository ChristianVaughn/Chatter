/**
 * Favourite GIFs and the categories they are sorted into.
 *
 * The invariant worth pinning: a category only ever holds favourites. Adding to
 * one favourites the GIF, unfavouriting takes it out of every one, and deleting
 * a category leaves its GIFs favourited — so the "All" list is always a
 * superset of whatever category is open.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const FAVS_KEY = "chatter_favorite_gifs";
const CATS_KEY = "chatter_gif_categories";

let store: Map<string, string>;

function installStorage() {
  store = new Map();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
    configurable: true,
  });
}

async function freshStore() {
  vi.resetModules();
  return (await import("@/hooks/useFavoriteGifs")).favoriteGifStore;
}

describe("favourite GIF categories", () => {
  beforeEach(installStorage);

  it("reads favourites saved before categories existed", async () => {
    store.set(FAVS_KEY, JSON.stringify(["a.gif", "b.gif"]));
    const s = await freshStore();
    expect(s.get()).toEqual({ favorites: ["a.gif", "b.gif"], categories: [] });
  });

  it("favourites a GIF when it is put in a category", async () => {
    const s = await freshStore();
    const id = s.createCategory("  Reactions  ")!;
    s.setInCategory(id, "a.gif", true);
    expect(s.get().favorites).toEqual(["a.gif"]);
    expect(s.get().categories).toEqual([{ id, name: "Reactions", urls: ["a.gif"] }]);
    expect(JSON.parse(store.get(CATS_KEY)!)[0].urls).toEqual(["a.gif"]);
  });

  it("takes an unfavourited GIF out of every category", async () => {
    const s = await freshStore();
    const one = s.createCategory("One")!;
    const two = s.createCategory("Two")!;
    s.setInCategory(one, "a.gif", true);
    s.setInCategory(two, "a.gif", true);
    s.removeFavorite("a.gif");
    expect(s.get().favorites).toEqual([]);
    expect(s.get().categories.map((c) => c.urls)).toEqual([[], []]);
  });

  it("keeps the GIFs favourited when their category is deleted", async () => {
    const s = await freshStore();
    const id = s.createCategory("Cats")!;
    s.setInCategory(id, "a.gif", true);
    s.deleteCategory(id);
    expect(s.get()).toEqual({ favorites: ["a.gif"], categories: [] });
  });

  it("refuses empty names and caps long ones", async () => {
    const s = await freshStore();
    expect(s.createCategory("   ")).toBeNull();
    const id = s.createCategory("x".repeat(100))!;
    expect(s.get().categories[0].name).toHaveLength(32);
    s.renameCategory(id, "  ");
    expect(s.get().categories[0].name).toHaveLength(32);
  });

  it("drops stored category entries that are no longer favourites", async () => {
    store.set(FAVS_KEY, JSON.stringify(["a.gif"]));
    store.set(CATS_KEY, JSON.stringify([{ id: "c", name: "C", urls: ["a.gif", "gone.gif"] }, { junk: true }]));
    const s = await freshStore();
    expect(s.get().categories).toEqual([{ id: "c", name: "C", urls: ["a.gif"] }]);
  });
});
