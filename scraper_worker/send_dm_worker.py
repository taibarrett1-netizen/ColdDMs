import argparse
import json
import sys
from typing import Any, Dict, List

from instagrapi.exceptions import (
  ClientError,
  ClientLoginRequired,
  ChallengeRequired,
  FeedbackRequired,
)

from .db import get_connection
from .instagram_client import build_client_from_session


def _load_sender_session(conn, session_id: int) -> Dict[str, Any]:
  with conn.cursor() as cur:
    cur.execute(
      """
      SELECT session_data, instagram_username
      FROM cold_dm_instagram_sessions
      WHERE id = %s
      """,
      (session_id,),
    )
    row = cur.fetchone()
  if not row:
    raise RuntimeError(f"Instagram session id {session_id} not found.")
  session_data, instagram_username = row
  return {
    "session_data": session_data or {},
    "instagram_username": instagram_username,
  }


def _map_error(e: Exception) -> Dict[str, Any]:
  etype = type(e).__name__
  reason = "unknown_error"

  if isinstance(e, ClientLoginRequired):
    reason = "login_required"
  elif isinstance(e, ChallengeRequired):
    reason = "challenge_required"
  elif isinstance(e, FeedbackRequired):
    reason = "feedback_required"
  elif isinstance(e, ClientError):
    msg = str(e).lower()
    if "user not found" in msg or "unable to find user" in msg:
      reason = "user_not_found"
    elif "not allowed to message" in msg or "cannot create thread" in msg:
      reason = "messages_restricted"
    elif "private" in msg:
      reason = "account_private"
    elif "rate limit" in msg or "try again later" in msg or "too many" in msg:
      reason = "rate_limited"

  return {
    "success": False,
    "error_type": etype,
    "reason": reason,
    "error": str(e),
  }


def send_dm(conn, client_id: str, session_id: int, username: str, message: str) -> Dict[str, Any]:
  session_row = _load_sender_session(conn, session_id)
  session_data = session_row["session_data"]
  instagram_username = session_row.get("instagram_username")

  cl = build_client_from_session(session_data, instagram_username)

  clean_username = (username or "").strip().lstrip("@")
  if not clean_username:
    raise RuntimeError("username is required")

  try:
    user_id = cl.user_id_from_username(clean_username)
  except Exception as e:
    return _map_error(e)

  try:
    dm = cl.direct_send(text=message, user_ids=[user_id])
  except Exception as e:
    return _map_error(e)

  payload: Dict[str, Any] = {
    "success": True,
    "reason": None,
    "error": None,
    "error_type": None,
    "thread_id": getattr(dm, "thread_id", None) or getattr(dm, "thread_id", None),
    "message_id": getattr(dm, "id", None),
    "sent_at": getattr(dm, "timestamp", None).isoformat() if getattr(dm, "timestamp", None) else None,
  }
  return payload


def main(argv: List[str]) -> int:
  parser = argparse.ArgumentParser(
    description="Send a single Instagram DM using instagrapi and an existing session."
  )
  parser.add_argument("--client-id", required=True, help="Tenant client_id (UUID)")
  parser.add_argument("--session-id", required=True, type=int, help="cold_dm_instagram_sessions.id")
  parser.add_argument("--username", required=True, help="Target Instagram username (@optional)")
  parser.add_argument("--message", required=True, help="Message text to send")

  args = parser.parse_args(argv)

  with get_connection() as conn:
    try:
      result = send_dm(conn, args.client_id, args.session_id, args.username, args.message)
    except Exception as e:
      result = _map_error(e)

  try:
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
  except Exception:
    return 1

  return 0 if result.get("success") else 1


if __name__ == "__main__":
  raise SystemExit(main(sys.argv[1:]))

