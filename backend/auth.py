import os
import time
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
import bcrypt
import jwt
from fastapi import Depends, HTTPException, status, Header, Query, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel

from config import settings
from database import get_db

security = HTTPBearer(auto_error=False)

class UserLogin(BaseModel):
    username: str
    password: str

class UserResponse(BaseModel):
    username: str
    role: str
    created_at: datetime

def hash_password(password: str) -> str:
    """Hashes a plain password using bcrypt."""
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """Verify a password without allowing malformed stored hashes to crash login."""
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
    except (ValueError, TypeError, AttributeError):
        return False

def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    """Creates a signed JWT access token."""
    to_encode = data.copy()
    expire = datetime.utcnow() + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire, "iat": datetime.utcnow()})
    return jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)

def decode_access_token(token: str) -> Dict[str, Any]:
    """Decodes and validates a JWT token."""
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        return payload
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired authentication token",
            headers={"WWW-Authenticate": "Bearer"}
        )

async def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    """Look up an existing user; a database failure must never authenticate anyone."""
    try:
        col = get_db()["users"]
        return await col.find_one({"username": username})
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is temporarily unavailable",
        ) from exc

async def init_admin_user():
    """Seed an administrator only for an empty, explicitly configured installation.

    Existing account documents and password hashes are never changed.  In particular,
    a temporarily missing configured username must not create a second privileged
    account in a database that already contains users.
    """
    col = get_db()["users"]
    admin = await col.find_one({"username": settings.ADMIN_USERNAME})
    if admin:
        return
    if await col.find_one({}):
        return

    explicit_fields = getattr(settings, "model_fields_set", set())
    password_is_configured = (
        "ADMIN_DEFAULT_PASSWORD" in os.environ
        or "ADMIN_DEFAULT_PASSWORD" in explicit_fields
    )
    if not password_is_configured or not settings.ADMIN_DEFAULT_PASSWORD:
        raise RuntimeError(
            "An initial administrator password must be configured privately for a new database."
        )
    hashed = hash_password(settings.ADMIN_DEFAULT_PASSWORD)
    await col.insert_one({
        "username": settings.ADMIN_USERNAME,
        "password_hash": hashed,
        "role": "admin",
        "created_at": datetime.utcnow(),
    })

async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> Dict[str, Any]:
    """Enforces authentication via standard Authorization: Bearer header."""
    if not credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"}
        )
    payload = decode_access_token(credentials.credentials)
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token subject")
    
    user = await get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User no longer exists")
    return user

async def get_current_user_flexible(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    token: Optional[str] = Query(None)
) -> Dict[str, Any]:
    """
    Flexible auth for video streams and media assets:
    Accepts Bearer header, ?token= query parameter, or access_token cookie.
    Guarantees HTML5 video elements can stream with full cryptographic verification.
    """
    raw_token = None
    if credentials:
        raw_token = credentials.credentials
    elif token:
        raw_token = token
    elif "access_token" in request.cookies:
        raw_token = request.cookies["access_token"]

    if not raw_token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required to stream or access media",
            headers={"WWW-Authenticate": "Bearer"}
        )

    payload = decode_access_token(raw_token)
    username = payload.get("sub")
    if not username:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token subject")

    user = await get_user_by_username(username)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    return user

async def validate_ws_token(token: Optional[str] = Query(None)) -> Optional[Dict[str, Any]]:
    """Strictly validates token for WebSocket connections."""
    if not token:
        return None
    try:
        payload = decode_access_token(token)
        username = payload.get("sub")
        if username:
            return await get_user_by_username(username)
    except Exception:
        pass
    return None
