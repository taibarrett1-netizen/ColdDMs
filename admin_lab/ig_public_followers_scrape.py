#!/usr/bin/env python3
"""
Login-less public follower scrape via Instagram web_profile_info + GraphQL (doc_id from env).
Uses a single sticky proxy for the whole run. Rotate ADMIN_LAB_IG_DOC_ID_FOLLOWERS from DevTools
(Network tab -> graphql/query -> doc_id) every few weeks when pagination breaks.

User ids are cached under admin_lab/.cache/user_ids.json with ADMIN_LAB_USER_ID_CACHE_TTL_SEC (default 30d).
Use --resolve_only for a dedicated resolver path; web_profile_info 429s use minute-scale backoffs
(ADMIN_LAB_WEB_PROFILE_429_BACKOFF_SEC).

Bandwidth: keep --max_users modest; trial proxies (~100MB) burn quickly on retries.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import datetime
import json
import os
import random
import re
import sys
import time
from http.cookies import SimpleCookie
from typing import Any, Dict, List, Optional, Tuple

import httpx

# Rotating desktop / mobile UAs (Instagram web)
USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
]

IG_APP_ID = "936619743392459"
CHECKPOINT_EVERY = max(10, int(os.getenv("ADMIN_LAB_CHECKPOINT_EVERY", "50")))


def pick_ua() -> str:
    return random.choice(USER_AGENTS)


def base_headers() -> Dict[str, str]:
    return {
        "User-Agent": pick_ua(),
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "X-IG-App-ID": IG_APP_ID,
        "X-Requested-With": "XMLHttpRequest",
        "Origin": "https://www.instagram.com",
        "Referer": "https://www.instagram.com/",
    }


def walk_find_edges(obj: Any, depth: int = 0) -> Optional[List[Dict[str, Any]]]:
    if depth > 14:
        return None
    if isinstance(obj, dict):
        edges = obj.get("edges")
        if isinstance(edges, list) and edges:
            first = edges[0]
            if isinstance(first, dict) and "node" in first:
                node = first.get("node")
                if isinstance(node, dict) and "username" in node:
                    return edges
        for v in obj.values():
            r = walk_find_edges(v, depth + 1)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for it in obj:
            r = walk_find_edges(it, depth + 1)
            if r is not None:
                return r
    return None


def walk_find_page_info(obj: Any, depth: int = 0) -> Optional[Dict[str, Any]]:
    if depth > 14:
        return None
    if isinstance(obj, dict):
        if "page_info" in obj and isinstance(obj["page_info"], dict):
            return obj["page_info"]
        for v in obj.values():
            r = walk_find_page_info(v, depth + 1)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for it in obj:
            r = walk_find_page_info(it, depth + 1)
            if r is not None:
                return r
    return None


def _extract_user_id_from_html(html: str) -> Optional[str]:
    """Best-effort parse of profile HTML / embedded JSON (when API is 429)."""
    if not html or len(html) < 200:
        return None
    patterns = [
        r'"profilePage_(\d{5,20})"',
        r'"user_id"\s*:\s*"(\d{5,20})"',
        r'"id"\s*:\s*"(\d{5,20})"\s*,\s*"username"',
        r'"target_user_id"\s*:\s*"(\d{5,20})"',
    ]
    for pat in patterns:
        m = re.search(pat, html)
        if m:
            return m.group(1)
    return None


async def fetch_user_id_from_profile_html(
    client: httpx.AsyncClient,
    username: str,
    cookie_header: Optional[str],
) -> Optional[str]:
    url = f"https://www.instagram.com/{username}/"
    headers: Dict[str, str] = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        ),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.instagram.com/",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
    }
    if cookie_header:
        headers["Cookie"] = cookie_header
    try:
        r = await client.get(url, headers=headers, timeout=45.0, follow_redirects=True)
        if r.status_code >= 400:
            return None
        return _extract_user_id_from_html(r.text)
    except Exception:
        return None


def _web_profile_429_backoffs_sec() -> List[float]:
    raw = (os.getenv("ADMIN_LAB_WEB_PROFILE_429_BACKOFF_SEC") or "60,180,600").strip()
    parts = [float(x.strip()) for x in raw.split(",") if x.strip()]
    return parts if parts else [60.0, 180.0, 600.0]


async def fetch_profile_user_id(
    client: httpx.AsyncClient,
    username: str,
    cookie_header: Optional[str] = None,
) -> str:
    """
    Resolve numeric user id via web_profile_info (and optional HTML fallback).
    On HTTP 429, uses minute-scale backoffs from ADMIN_LAB_WEB_PROFILE_429_BACKOFF_SEC
    (default 60,180,600 seconds) instead of tight retry loops.
    """
    backoffs = _web_profile_429_backoffs_sec()
    # With session cookies, www-only tends to 429 less than i.instagram.com.
    if cookie_header:
        urls = [
            f"https://www.instagram.com/api/v1/users/web_profile_info/?username={username}",
        ]
    else:
        urls = [
            f"https://www.instagram.com/api/v1/users/web_profile_info/?username={username}",
            f"https://i.instagram.com/api/v1/users/web_profile_info/?username={username}",
        ]
    last_err: Optional[Exception] = None
    for url in urls:
        i429 = 0
        for soft_try in range(8):
            try:
                headers = base_headers()
                headers["Referer"] = f"https://www.instagram.com/{username}/"
                if cookie_header:
                    headers["Cookie"] = cookie_header
                    csrf = csrf_from_cookie_header(cookie_header)
                    if csrf:
                        headers["X-CSRFToken"] = csrf
                r = await client.get(url, headers=headers, timeout=45.0)
                if r.status_code == 429:
                    last_err = RuntimeError(f"HTTP 429 from web_profile_info ({url})")
                    if i429 < len(backoffs):
                        w = backoffs[i429] + random.uniform(10.0, 45.0)
                        sys.stderr.write(
                            f"[admin-lab] web_profile_info 429, sleeping {w:.0f}s "
                            f"(backoff {i429 + 1}/{len(backoffs)})\n"
                        )
                        await asyncio.sleep(w)
                        i429 += 1
                        continue
                    sys.stderr.write(f"[admin-lab] web_profile_info 429 retries exhausted for {url}\n")
                    break
                if r.status_code >= 400:
                    body_preview = r.text[:240].replace("\n", " ")
                    raise RuntimeError(
                        f"HTTP {r.status_code} from web_profile_info ({url}) body={body_preview}"
                    )
                data = r.json()
                uid = (
                    data.get("data", {})
                    .get("user", {})
                    .get("id")
                )
                if not uid:
                    raise RuntimeError(
                        f"Unexpected web_profile_info shape from {url}: {json.dumps(data)[:500]}"
                    )
                return str(uid)
            except Exception as e:
                last_err = e
                if soft_try < 5:
                    await asyncio.sleep(1.8 ** soft_try + random.uniform(0.3, 1.4))
                    continue
                break
    if cookie_header:
        sys.stderr.write("[admin-lab] web_profile_info exhausted; trying profile HTML parse for user id\n")
        html_uid = await fetch_user_id_from_profile_html(client, username, cookie_header)
        if html_uid:
            return str(html_uid)
    raise RuntimeError(f"web_profile_info failed: {last_err}")


async def graphql_followers_page(
    client: httpx.AsyncClient,
    doc_id: str,
    user_id: str,
    first: int,
    after: Optional[str],
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    variables: Dict[str, Any] = {"id": user_id, "first": first}
    if after:
        variables["after"] = after

    body = {
        "doc_id": doc_id,
        "variables": json.dumps(variables, separators=(",", ":")),
    }
    url = "https://www.instagram.com/graphql/query/"
    gql_backoffs = [
        float(x.strip())
        for x in (os.getenv("ADMIN_LAB_GRAPHQL_429_BACKOFF_SEC") or "45,120,300").split(",")
        if x.strip()
    ] or [45.0, 120.0, 300.0]
    last_err: Optional[Exception] = None
    i429 = 0
    for attempt in range(8):
        try:
            headers = base_headers()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
            r = await client.post(url, data=body, headers=headers, timeout=60.0)
            if r.status_code == 429:
                last_err = RuntimeError(f"GraphQL HTTP 429")
                if i429 < len(gql_backoffs):
                    wait = gql_backoffs[i429] + random.uniform(5.0, 25.0)
                    sys.stderr.write(
                        f"[admin-lab] graphql rate limited, sleeping {wait:.0f}s ({i429 + 1}/{len(gql_backoffs)})\n"
                    )
                    await asyncio.sleep(wait)
                    i429 += 1
                    continue
                raise RuntimeError("GraphQL HTTP 429: backoff exhausted")
            if r.status_code >= 400:
                raise RuntimeError(f"GraphQL HTTP {r.status_code}: {r.text[:500]}")
            data = r.json()
            if "errors" in data and data["errors"]:
                raise RuntimeError(f"GraphQL errors: {data['errors'][:3]}")
            edges = walk_find_edges(data)
            if edges is None:
                raise RuntimeError(
                    "Could not find follower edges in GraphQL response. "
                    "Update ADMIN_LAB_IG_DOC_ID_FOLLOWERS from DevTools (followers query)."
                )
            page_info = walk_find_page_info(data) or {}
            return edges, page_info
        except RuntimeError as e:
            if "backoff exhausted" in str(e):
                raise
            last_err = e
            await asyncio.sleep(1.2 ** attempt + random.uniform(0.3, 1.2))
        except Exception as e:
            last_err = e
            await asyncio.sleep(1.2 ** attempt + random.uniform(0.3, 1.2))
    raise RuntimeError(f"graphql followers failed: {last_err}")


def _user_id_cache_file() -> str:
    return os.path.join(os.path.dirname(__file__), ".cache", "user_ids.json")


def _norm_username(username: str) -> str:
    return username.strip().lstrip("@").lower()


def _user_id_cache_ttl_sec() -> int:
    return max(3600, int(os.getenv("ADMIN_LAB_USER_ID_CACHE_TTL_SEC") or "2592000"))


def _read_user_id_cache_raw() -> Dict[str, Any]:
    path = _user_id_cache_file()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return raw if isinstance(raw, dict) else {}
    except Exception:
        return {}


def _expires_at_from_entry(entry: Dict[str, Any]) -> Optional[float]:
    exp = entry.get("expires_at")
    if isinstance(exp, (int, float)):
        return float(exp)
    if isinstance(exp, str):
        try:
            dt = datetime.datetime.fromisoformat(exp.replace("Z", "+00:00"))
            return dt.timestamp()
        except Exception:
            return None
    return None


def load_cached_user_id(username: str) -> Optional[str]:
    """
    Return cached numeric user id if present and not past expires_at.
    Legacy entries (plain string) are treated as valid and rewritten with a fresh TTL on save.
    """
    key = _norm_username(username)
    data = _read_user_id_cache_raw()
    raw = data.get(key)
    if raw is None:
        return None
    now = time.time()
    if isinstance(raw, str):
        return str(raw) if raw.strip() else None
    if isinstance(raw, dict):
        uid = raw.get("id")
        if not uid:
            return None
        exp_ts = _expires_at_from_entry(raw)
        if exp_ts is not None and now > exp_ts:
            return None
        return str(uid)
    return None


def save_cached_user_id(username: str, uid: str) -> None:
    cache_dir = os.path.join(os.path.dirname(__file__), ".cache")
    os.makedirs(cache_dir, exist_ok=True)
    path = _user_id_cache_file()
    data = _read_user_id_cache_raw()
    ttl = _user_id_cache_ttl_sec()
    now = time.time()
    # Migrate legacy string values to structured entries when we touch the file.
    for k, v in list(data.items()):
        if isinstance(v, str) and v.strip():
            data[k] = {
                "id": str(v).strip(),
                "resolved_at": datetime.datetime.utcfromtimestamp(now).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "expires_at": now + ttl,
            }
    key = _norm_username(username)
    data[key] = {
        "id": str(uid),
        "resolved_at": datetime.datetime.utcfromtimestamp(now).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "expires_at": now + ttl,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)


async def run_resolve_only(username: str, proxy: str) -> Dict[str, Any]:
    """Resolve username -> user id using the same cookie jar as scrape; updates TTL cache."""
    un = _norm_username(username)
    cached = load_cached_user_id(un)
    if cached:
        raw = _read_user_id_cache_raw().get(un)
        exp_iso = ""
        if isinstance(raw, dict):
            exp_ts = _expires_at_from_entry(raw)
            if exp_ts is not None:
                exp_iso = datetime.datetime.utcfromtimestamp(exp_ts).strftime("%Y-%m-%dT%H:%M:%SZ")
        return {"ok": True, "userId": cached, "cached": True, "expiresAt": exp_iso}

    transport = httpx.AsyncHTTPTransport(retries=1)
    async with httpx.AsyncClient(
        proxy=proxy.strip(),
        transport=transport,
        follow_redirects=True,
        timeout=httpx.Timeout(90.0),
    ) as client:
        cookie_header = load_cookie_header()
        uid = await fetch_profile_user_id(
            client,
            un,
            cookie_header if cookie_header else None,
        )
        save_cached_user_id(un, uid)
    ttl = _user_id_cache_ttl_sec()
    exp = time.time() + ttl
    exp_iso = datetime.datetime.utcfromtimestamp(exp).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"ok": True, "userId": uid, "cached": False, "expiresAt": exp_iso}


def load_cookie_header() -> str:
    """
    Option A (api_v1) generally requires authenticated cookies.
    Priority:
    1) ADMIN_LAB_IG_COOKIE_HEADER (raw Cookie header string)
    2) sender session cookie JSON (ADMIN_LAB_SESSION_PATH or default admin_lab/.sessions/sender.json)
    """
    env_cookie = (os.getenv("ADMIN_LAB_IG_COOKIE_HEADER") or "").strip()
    if env_cookie:
        return env_cookie

    session_path = (os.getenv("ADMIN_LAB_SESSION_PATH") or "").strip()
    if not session_path:
        session_path = os.path.join(os.path.dirname(__file__), ".sessions", "sender.json")
    try:
        with open(session_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        cookies = data.get("cookies") if isinstance(data, dict) else None
        if not isinstance(cookies, list):
            return ""
        parts: List[str] = []
        for c in cookies:
            if not isinstance(c, dict):
                continue
            name = str(c.get("name") or "").strip()
            value = str(c.get("value") or "")
            if not name:
                continue
            parts.append(f"{name}={value}")
        return "; ".join(parts)
    except Exception:
        return ""


def csrf_from_cookie_header(cookie_header: str) -> str:
    if not cookie_header:
        return ""
    jar = SimpleCookie()
    try:
        jar.load(cookie_header)
    except Exception:
        return ""
    morsel = jar.get("csrftoken")
    return morsel.value if morsel else ""


async def api_v1_followers_page(
    client: httpx.AsyncClient,
    username: str,
    user_id: str,
    count: int,
    max_id: Optional[str],
    cookie_header: str,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    url = f"https://www.instagram.com/api/v1/friendships/{user_id}/followers/"
    params: Dict[str, str] = {
        "count": str(count),
        "search_surface": "follow_list_page",
    }
    if max_id:
        params["max_id"] = max_id
    headers = base_headers()
    headers["Referer"] = f"https://www.instagram.com/{username}/followers/"
    if cookie_header:
        headers["Cookie"] = cookie_header
        csrf = csrf_from_cookie_header(cookie_header)
        if csrf:
            headers["X-CSRFToken"] = csrf
    last_err: Optional[Exception] = None
    for attempt in range(5):
        try:
            r = await client.get(url, params=params, headers=headers, timeout=60.0)
            if r.status_code == 429:
                last_err = RuntimeError("api_v1 followers HTTP 429")
                await asyncio.sleep(min(90.0, 2 ** attempt + random.uniform(2, 8)))
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"api_v1 followers HTTP {r.status_code}: {r.text[:500]}")
            data = r.json()
            users = data.get("users")
            if not isinstance(users, list):
                raise RuntimeError(f"api_v1 response missing users array: {json.dumps(data)[:500]}")
            next_max_id = data.get("next_max_id")
            if next_max_id is not None:
                next_max_id = str(next_max_id)
            return users, next_max_id
        except Exception as e:
            last_err = e
            await asyncio.sleep(1.2 ** attempt + random.uniform(0.3, 1.2))
    raise RuntimeError(f"api_v1 followers failed: {last_err}")


def append_rows_csv(path: str, rows: List[Dict[str, str]], write_header: bool) -> None:
    fieldnames = ["username", "full_name", "id", "is_private"]
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        if write_header:
            w.writeheader()
        for row in rows:
            w.writerow(row)


def node_to_row(node: Dict[str, Any]) -> Dict[str, str]:
    return {
        "username": str(node.get("username") or ""),
        "full_name": str(node.get("full_name") or ""),
        "id": str(node.get("id") or ""),
        "is_private": str(node.get("is_private", "")).lower()
        if node.get("is_private") is not None
        else "",
    }


async def run_scrape(username: str, proxy: str, max_users: int, output: str, user_id: Optional[str] = None) -> int:
    mode = (os.getenv("ADMIN_LAB_SCRAPE_MODE") or "graphql").strip().lower()
    doc_id = (os.getenv("ADMIN_LAB_IG_DOC_ID_FOLLOWERS") or "").strip()
    if mode in ("graphql", "auto") and not doc_id:
        print("ADMIN_LAB_IG_DOC_ID_FOLLOWERS is required for graphql/auto modes", file=sys.stderr)
        sys.exit(2)

    # When using api_v1, keep counts modest.
    first = min(40, max(12, int(os.getenv("ADMIN_LAB_GRAPHQL_FIRST", "40"))))
    api_count = min(50, max(12, int(os.getenv("ADMIN_LAB_API_V1_COUNT", "24"))))

    transport = httpx.AsyncHTTPTransport(retries=1)
    async with httpx.AsyncClient(
        proxy=proxy,
        transport=transport,
        follow_redirects=True,
        timeout=httpx.Timeout(90.0),
    ) as client:
        cookie_header = load_cookie_header()
        uid = user_id.strip() if isinstance(user_id, str) and user_id.strip() else None
        require_cached = (os.getenv("ADMIN_LAB_SCRAPE_REQUIRE_CACHED_USER_ID") or "").strip().lower() in (
            "1",
            "true",
            "yes",
        )
        if not uid:
            uid = load_cached_user_id(username)
            if uid:
                sys.stderr.write(f"[admin-lab] Using cached user id for @{username} -> {uid}\n")
        if not uid:
            if require_cached:
                raise RuntimeError(
                    "No cached user id (or cache expired). Call POST /api/admin-lab/scrape/resolve first, "
                    "pass --user_id / targetUserId, or unset ADMIN_LAB_SCRAPE_REQUIRE_CACHED_USER_ID."
                )
            uid = await fetch_profile_user_id(
                client,
                username,
                cookie_header if cookie_header else None,
            )
            save_cached_user_id(username, uid)
        sys.stderr.write(f"[admin-lab] Resolved @{username} -> id={uid}\n")

        after: Optional[str] = None
        max_id: Optional[str] = None
        collected = 0
        buffer: List[Dict[str, str]] = []
        header_written = bool(os.path.exists(output) and os.path.getsize(output) > 0)
        if mode in ("api_v1", "auto") and not cookie_header:
            raise RuntimeError(
                "ADMIN_LAB_SCRAPE_MODE=api_v1 requires authenticated cookies. "
                "Set ADMIN_LAB_IG_COOKIE_HEADER or connect sender so admin_lab/.sessions/sender.json exists."
            )

        while collected < max_users:
            if mode == "api_v1":
                users, max_id = await api_v1_followers_page(
                    client, username=username, user_id=uid, count=api_count, max_id=max_id, cookie_header=cookie_header
                )
                await asyncio.sleep(random.uniform(1.0, 2.8))
                for node in users:
                    if collected >= max_users:
                        break
                    if not isinstance(node, dict):
                        continue
                    buffer.append(node_to_row(node))
                    collected += 1
                    if len(buffer) >= CHECKPOINT_EVERY:
                        append_rows_csv(output, buffer, write_header=not header_written)
                        header_written = True
                        buffer.clear()
                        sys.stderr.write(f"[admin-lab] checkpoint {collected} rows\n")
                if buffer:
                    append_rows_csv(output, buffer, write_header=not header_written)
                    header_written = True
                    buffer.clear()
                if not max_id:
                    break
            else:
                try:
                    edges, page_info = await graphql_followers_page(client, doc_id, uid, first, after)
                except Exception:
                    if mode == "auto":
                        users, max_id = await api_v1_followers_page(
                            client, username=username, user_id=uid, count=api_count, max_id=max_id, cookie_header=cookie_header
                        )
                        await asyncio.sleep(random.uniform(1.0, 2.8))
                        for node in users:
                            if collected >= max_users:
                                break
                            if not isinstance(node, dict):
                                continue
                            buffer.append(node_to_row(node))
                            collected += 1
                            if len(buffer) >= CHECKPOINT_EVERY:
                                append_rows_csv(output, buffer, write_header=not header_written)
                                header_written = True
                                buffer.clear()
                                sys.stderr.write(f"[admin-lab] checkpoint {collected} rows\n")
                        if buffer:
                            append_rows_csv(output, buffer, write_header=not header_written)
                            header_written = True
                            buffer.clear()
                        if not max_id:
                            break
                        continue
                    raise

                await asyncio.sleep(random.uniform(0.8, 2.2))
                for edge in edges:
                    if collected >= max_users:
                        break
                    node = edge.get("node") if isinstance(edge, dict) else None
                    if not isinstance(node, dict):
                        continue
                    buffer.append(node_to_row(node))
                    collected += 1
                    if len(buffer) >= CHECKPOINT_EVERY:
                        append_rows_csv(output, buffer, write_header=not header_written)
                        header_written = True
                        buffer.clear()
                        sys.stderr.write(f"[admin-lab] checkpoint {collected} rows\n")

                if buffer:
                    append_rows_csv(output, buffer, write_header=not header_written)
                    header_written = True
                    buffer.clear()

                has_next = bool(page_info.get("has_next_page"))
                after = page_info.get("end_cursor")
                if not has_next or not after:
                    break

        if buffer:
            append_rows_csv(output, buffer, write_header=not header_written)
            header_written = True

    return collected


def main() -> None:
    p = argparse.ArgumentParser(description="Instagram public followers scrape (login-less, lab)")
    p.add_argument("--username", required=True)
    p.add_argument(
        "--resolve_only",
        action="store_true",
        help="Only resolve username to numeric user id (TTL cache); prints one JSON object on stdout.",
    )
    p.add_argument("--user_id", required=False, help="Optional: bypass web_profile_info lookup (use numeric IG user id)")
    p.add_argument("--proxy", required=False, help="HTTP proxy URL, e.g. http://user:pass@host:port")
    p.add_argument("--max_users", type=int, default=500)
    p.add_argument("--output", required=False, help="Output CSV path")
    args = p.parse_args()

    if args.resolve_only:
        if not args.proxy or not str(args.proxy).strip():
            print(json.dumps({"ok": False, "error": "--proxy is required with --resolve_only"}))
            sys.exit(1)
        try:
            out = asyncio.run(run_resolve_only(args.username.strip().lstrip("@"), str(args.proxy).strip()))
            print(json.dumps(out))
            sys.exit(0 if out.get("ok") else 1)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    if not args.output:
        print("--output is required unless --resolve_only", file=sys.stderr)
        sys.exit(2)
    if not args.proxy or not str(args.proxy).strip():
        print("--proxy is required for scrape", file=sys.stderr)
        sys.exit(2)

    t0 = time.time()
    n = asyncio.run(
        run_scrape(
            args.username.strip().lstrip("@"),
            str(args.proxy).strip(),
            int(args.max_users),
            args.output,
            args.user_id,
        )
    )
    sys.stderr.write(f"[admin-lab] Done: {n} users in {time.time() - t0:.1f}s -> {args.output}\n")
    print(f"ROWCOUNT={n}")


if __name__ == "__main__":
    main()
