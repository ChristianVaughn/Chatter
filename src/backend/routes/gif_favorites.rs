//! The caller's favourite GIFs and the categories they sort them into, so the
//! collection follows them to every device they sign in from.
//!
//! One document per user, read by nobody else. It is changed by *operations*
//! — favourite this, file that under "Reactions" — rather than replaced whole
//! the way appearance settings are. Favouriting is something done in passing on
//! whichever device is to hand, often two at once, and a whole-document replace
//! would have the second device's save quietly drop the first device's GIF.
//! An operation applied to whatever the server holds cannot lose anything.
//!
//! The invariant every operation keeps: a category only ever holds favourites.
//! Filing a GIF favourites it, unfavouriting takes it out of every category,
//! and deleting a category leaves its GIFs favourited. The client applies the
//! same rules optimistically (`hooks/useFavoriteGifs.ts`) — change both
//! together.
//!
//! After every change the whole result is sent to the user's open sockets as
//! `gif_favorites`, carrying `rev`, so another open device updates without
//! refetching and a stale message can be told from a fresh one.

use super::super::{
    helpers::{error_response, extract_token, get_user_from_token, rate_limited, send_to_user},
    ratelimit,
    state::AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Json,
};
use mongodb::bson::doc;
use mongodb::options::ReplaceOptions;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

/// Enough for a real collection; a bound so one account cannot grow without one.
pub(crate) const MAX_FAVORITES: usize = 500;
pub(crate) const MAX_CATEGORIES: usize = 50;
/// Counted in characters, matching the client's `maxLength`.
pub(crate) const MAX_CATEGORY_NAME: usize = 32;
const MAX_URL_LEN: usize = 2048;
const MAX_ID_LEN: usize = 64;

/// A favourite is a click, so the burst covers someone sorting a collection
/// in one sitting; the sustained rate does not need to.
const GIF_FAVORITES_OPS: ratelimit::Quota = ratelimit::Quota {
    capacity: 60.0,
    refill_per_sec: 1.0,
};

/// Two devices writing the same document at once is rare and the loser simply
/// re-reads and re-applies; this only bounds a pathological loop.
const SAVE_ATTEMPTS: usize = 5;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct GifCategory {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) urls: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct GifFavoritesRecord {
    #[serde(rename = "_id")]
    pub(crate) user_id: String,
    /// Newest first.
    #[serde(default)]
    pub(crate) favorites: Vec<String>,
    #[serde(default)]
    pub(crate) categories: Vec<GifCategory>,
    /// Bumped on every write. It is both the optimistic-concurrency check on
    /// save and how a client orders the broadcasts it receives.
    #[serde(default)]
    pub(crate) rev: i64,
}

#[derive(Deserialize)]
pub(crate) struct ImportCategory {
    pub(crate) id: String,
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) urls: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub(crate) enum GifFavoritesOp {
    AddFavorite {
        url: String,
    },
    RemoveFavorite {
        url: String,
    },
    /// The client mints the id, so it can file a GIF under a category it has
    /// just created without waiting for the server to name it.
    CreateCategory {
        id: String,
        name: String,
    },
    RenameCategory {
        id: String,
        name: String,
    },
    DeleteCategory {
        id: String,
    },
    SetInCategory {
        id: String,
        url: String,
        in_category: bool,
    },
    /// Favourites kept in a browser before they were kept here. Merged, never
    /// replacing: the account may already have favourites from another device,
    /// and what does not fit under the caps is dropped rather than refused, so
    /// a large local collection is not stuck in the browser for ever.
    Import {
        #[serde(default)]
        favorites: Vec<String>,
        #[serde(default)]
        categories: Vec<ImportCategory>,
    },
}

/// A favourite reaches an `<img src>` on every device of its owner, so only
/// web URLs and files this instance hosts are kept.
pub(crate) fn valid_gif_url(url: &str) -> bool {
    url.len() <= MAX_URL_LEN
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
        && (url.starts_with("https://")
            || url.starts_with("http://")
            || url.starts_with("/external/"))
}

fn valid_category_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Trimmed and capped the way the client caps it, so a name looks the same on
/// every device. `None` for one that is empty once trimmed.
fn clean_name(name: &str) -> Option<String> {
    let trimmed: String = name.trim().chars().take(MAX_CATEGORY_NAME).collect();
    let trimmed = trimmed.trim_end().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn add_favorite(rec: &mut GifFavoritesRecord, url: &str) -> Result<(), &'static str> {
    if rec.favorites.iter().any(|u| u == url) {
        return Ok(());
    }
    if rec.favorites.len() >= MAX_FAVORITES {
        return Err("You can keep at most 500 favourite GIFs");
    }
    rec.favorites.insert(0, url.to_string());
    Ok(())
}

/// Apply one operation. `Err` carries a status and a message for the caller;
/// the record is only saved when this succeeds, so a refusal changes nothing.
pub(crate) fn apply_op(
    rec: &mut GifFavoritesRecord,
    op: GifFavoritesOp,
) -> Result<(), (StatusCode, &'static str)> {
    let bad = |msg| (StatusCode::BAD_REQUEST, msg);
    match op {
        GifFavoritesOp::AddFavorite { url } => {
            if !valid_gif_url(&url) {
                return Err(bad("Invalid GIF url"));
            }
            add_favorite(rec, &url).map_err(bad)?;
        }
        GifFavoritesOp::RemoveFavorite { url } => {
            rec.favorites.retain(|u| u != &url);
            for c in &mut rec.categories {
                c.urls.retain(|u| u != &url);
            }
        }
        GifFavoritesOp::CreateCategory { id, name } => {
            if !valid_category_id(&id) {
                return Err(bad("Invalid category id"));
            }
            let name = clean_name(&name).ok_or(bad("Category name cannot be empty"))?;
            // A retried create is the same create.
            if rec.categories.iter().any(|c| c.id == id) {
                return Ok(());
            }
            if rec.categories.len() >= MAX_CATEGORIES {
                return Err(bad("You can have at most 50 GIF categories"));
            }
            rec.categories.push(GifCategory {
                id,
                name,
                urls: Vec::new(),
            });
        }
        GifFavoritesOp::RenameCategory { id, name } => {
            let name = clean_name(&name).ok_or(bad("Category name cannot be empty"))?;
            let category = rec
                .categories
                .iter_mut()
                .find(|c| c.id == id)
                .ok_or((StatusCode::NOT_FOUND, "Category not found"))?;
            category.name = name;
        }
        GifFavoritesOp::DeleteCategory { id } => {
            rec.categories.retain(|c| c.id != id);
        }
        GifFavoritesOp::SetInCategory {
            id,
            url,
            in_category,
        } => {
            let Some(index) = rec.categories.iter().position(|c| c.id == id) else {
                return Err((StatusCode::NOT_FOUND, "Category not found"));
            };
            if in_category {
                if !valid_gif_url(&url) {
                    return Err(bad("Invalid GIF url"));
                }
                add_favorite(rec, &url).map_err(bad)?;
                let urls = &mut rec.categories[index].urls;
                if !urls.contains(&url) {
                    urls.insert(0, url);
                }
            } else {
                rec.categories[index].urls.retain(|u| u != &url);
            }
        }
        GifFavoritesOp::Import {
            favorites,
            categories,
        } => {
            // Appended, not prepended: what the account already holds is
            // what was favourited most recently somewhere.
            for url in favorites {
                if rec.favorites.len() >= MAX_FAVORITES {
                    break;
                }
                if valid_gif_url(&url) && !rec.favorites.contains(&url) {
                    rec.favorites.push(url);
                }
            }
            for incoming in categories {
                let Some(name) = clean_name(&incoming.name) else {
                    continue;
                };
                // Matched by id, then by name, so importing twice — or from
                // two browsers that both had a "Reactions" — makes one
                // category rather than two of the same name.
                let existing = rec.categories.iter().position(|c| {
                    c.id == incoming.id || c.name.to_lowercase() == name.to_lowercase()
                });
                let index = match existing {
                    Some(i) => i,
                    None => {
                        if rec.categories.len() >= MAX_CATEGORIES
                            || !valid_category_id(&incoming.id)
                        {
                            continue;
                        }
                        rec.categories.push(GifCategory {
                            id: incoming.id,
                            name,
                            urls: Vec::new(),
                        });
                        rec.categories.len() - 1
                    }
                };
                for url in incoming.urls {
                    // Only what made it into favourites, which keeps the
                    // invariant without a second cap.
                    if rec.favorites.contains(&url) && !rec.categories[index].urls.contains(&url) {
                        rec.categories[index].urls.push(url);
                    }
                }
            }
        }
    }
    Ok(())
}

fn to_json(rec: &GifFavoritesRecord) -> Value {
    json!({
        "favorites": rec.favorites,
        "categories": rec.categories,
        "rev": rec.rev,
    })
}

async fn load(
    state: &AppState,
    user_id: &str,
) -> Result<GifFavoritesRecord, (StatusCode, Json<Value>)> {
    state
        .db
        .collection::<GifFavoritesRecord>("gif_favorites")
        .find_one(doc! { "_id": user_id })
        .await
        .map(|found| {
            found.unwrap_or_else(|| GifFavoritesRecord {
                user_id: user_id.to_string(),
                ..Default::default()
            })
        })
        .map_err(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Database error"))
}

fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<String, (StatusCode, Json<Value>)> {
    let token = extract_token(headers)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing token"))?;
    get_user_from_token(state, &token)
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid token"))
}

/// GET /api/gif-favorites — an account that has never favourited anything
/// answers with empty lists, not a 404.
pub(crate) async fn get_gif_favorites(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = authenticate(&state, &headers)?;
    let rec = load(&state, &user_id).await?;
    Ok(Json(to_json(&rec)))
}

/// POST /api/gif-favorites — apply one operation and answer with the result.
pub(crate) async fn apply_gif_favorites_op(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(op): Json<Value>,
) -> Result<Json<Value>, (StatusCode, Json<Value>)> {
    let user_id = authenticate(&state, &headers)?;

    if let Err(retry_after) = ratelimit::check(
        &state,
        &format!("gif_favorites:{user_id}"),
        GIF_FAVORITES_OPS,
    )
    .await
    {
        return Err(rate_limited(retry_after, "Too many favourite changes"));
    }

    let coll = state.db.collection::<GifFavoritesRecord>("gif_favorites");
    for _ in 0..SAVE_ATTEMPTS {
        let mut rec = load(&state, &user_id).await?;
        let read_rev = rec.rev;
        // Re-parsed per attempt because applying consumes it.
        let parsed: GifFavoritesOp = serde_json::from_value(op.clone())
            .map_err(|_| error_response(StatusCode::BAD_REQUEST, "Invalid operation"))?;
        apply_op(&mut rec, parsed).map_err(|(status, msg)| error_response(status, msg))?;
        rec.rev = read_rev + 1;

        // Matches only the revision this was read at. If another device wrote
        // in between, the filter misses, the upsert collides on `_id`, and the
        // loop re-reads and re-applies onto what that device left.
        let saved = coll
            .replace_one(doc! { "_id": &user_id, "rev": read_rev }, &rec)
            .with_options(ReplaceOptions::builder().upsert(true).build())
            .await;
        match saved {
            Ok(_) => {
                let body = to_json(&rec);
                let mut event = body.clone();
                event["type"] = json!("gif_favorites");
                send_to_user(&state, &user_id, &event).await;
                return Ok(Json(body));
            }
            Err(e) if is_duplicate_key(&e) => continue,
            Err(_) => {
                return Err(error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Database error",
                ))
            }
        }
    }
    Err(error_response(
        StatusCode::CONFLICT,
        "Favourites were changing too quickly — try again",
    ))
}

fn is_duplicate_key(err: &mongodb::error::Error) -> bool {
    use mongodb::error::{ErrorKind, WriteFailure};
    match err.kind.as_ref() {
        ErrorKind::Write(WriteFailure::WriteError(w)) => w.code == 11000,
        ErrorKind::Command(c) => c.code == 11000,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn op(value: Value) -> GifFavoritesOp {
        serde_json::from_value(value).unwrap()
    }

    fn rec() -> GifFavoritesRecord {
        GifFavoritesRecord {
            user_id: "@a:localhost".into(),
            ..Default::default()
        }
    }

    #[test]
    fn filing_a_gif_favourites_it() {
        let mut r = rec();
        apply_op(
            &mut r,
            op(json!({"op": "create_category", "id": "c1", "name": "  Cats "})),
        )
        .unwrap();
        apply_op(&mut r, op(json!({"op": "set_in_category", "id": "c1", "url": "https://x/a.gif", "in_category": true}))).unwrap();
        assert_eq!(r.favorites, vec!["https://x/a.gif"]);
        assert_eq!(r.categories[0].name, "Cats");
        assert_eq!(r.categories[0].urls, vec!["https://x/a.gif"]);
    }

    #[test]
    fn unfavouriting_empties_every_category_and_deleting_a_category_keeps_favourites() {
        let mut r = rec();
        for id in ["c1", "c2"] {
            apply_op(
                &mut r,
                op(json!({"op": "create_category", "id": id, "name": id})),
            )
            .unwrap();
            apply_op(&mut r, op(json!({"op": "set_in_category", "id": id, "url": "https://x/a.gif", "in_category": true}))).unwrap();
        }
        apply_op(&mut r, op(json!({"op": "delete_category", "id": "c1"}))).unwrap();
        assert_eq!(r.favorites, vec!["https://x/a.gif"]);
        apply_op(
            &mut r,
            op(json!({"op": "remove_favorite", "url": "https://x/a.gif"})),
        )
        .unwrap();
        assert!(r.favorites.is_empty());
        assert!(r.categories[0].urls.is_empty());
    }

    #[test]
    fn creates_and_adds_are_idempotent() {
        let mut r = rec();
        for _ in 0..2 {
            apply_op(
                &mut r,
                op(json!({"op": "create_category", "id": "c1", "name": "A"})),
            )
            .unwrap();
            apply_op(
                &mut r,
                op(json!({"op": "add_favorite", "url": "https://x/a.gif"})),
            )
            .unwrap();
        }
        assert_eq!(r.categories.len(), 1);
        assert_eq!(r.favorites.len(), 1);
    }

    #[test]
    fn refuses_unsafe_urls_ids_and_names() {
        let mut r = rec();
        assert!(apply_op(
            &mut r,
            op(json!({"op": "add_favorite", "url": "javascript:alert(1)"}))
        )
        .is_err());
        assert!(apply_op(
            &mut r,
            op(json!({"op": "add_favorite", "url": "//evil/a.gif"}))
        )
        .is_err());
        assert!(apply_op(
            &mut r,
            op(json!({"op": "create_category", "id": "a\"b", "name": "x"}))
        )
        .is_err());
        assert!(apply_op(
            &mut r,
            op(json!({"op": "create_category", "id": "ok", "name": "   "}))
        )
        .is_err());
        assert!(apply_op(
            &mut r,
            op(json!({"op": "add_favorite", "url": "/external/abc/a.gif"}))
        )
        .is_ok());
    }

    #[test]
    fn caps_names_and_favourites() {
        let mut r = rec();
        apply_op(
            &mut r,
            op(json!({"op": "create_category", "id": "c", "name": "é".repeat(40)})),
        )
        .unwrap();
        assert_eq!(r.categories[0].name.chars().count(), MAX_CATEGORY_NAME);
        for i in 0..MAX_FAVORITES {
            apply_op(
                &mut r,
                op(json!({"op": "add_favorite", "url": format!("https://x/{i}.gif")})),
            )
            .unwrap();
        }
        assert!(apply_op(
            &mut r,
            op(json!({"op": "add_favorite", "url": "https://x/over.gif"}))
        )
        .is_err());
    }

    #[test]
    fn import_merges_by_id_or_name_and_keeps_only_favourites_in_categories() {
        let mut r = rec();
        apply_op(
            &mut r,
            op(json!({"op": "add_favorite", "url": "https://x/server.gif"})),
        )
        .unwrap();
        apply_op(
            &mut r,
            op(json!({"op": "create_category", "id": "srv", "name": "Reactions"})),
        )
        .unwrap();
        apply_op(
            &mut r,
            op(json!({
                "op": "import",
                "favorites": ["https://x/local.gif", "https://x/server.gif", "bad url"],
                "categories": [
                    {"id": "loc", "name": "reactions", "urls": ["https://x/local.gif", "https://x/never-favourited.gif"]},
                    {"id": "new", "name": "Memes", "urls": []}
                ]
            })),
        )
        .unwrap();
        assert_eq!(
            r.favorites,
            vec!["https://x/server.gif", "https://x/local.gif"]
        );
        assert_eq!(r.categories.len(), 2);
        assert_eq!(r.categories[0].id, "srv");
        assert_eq!(r.categories[0].urls, vec!["https://x/local.gif"]);
        assert_eq!(r.categories[1].name, "Memes");
    }
}
