import time
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
import bcrypt
import jwt
from fastapi import Depends, HTTPException, status, Header, Query
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
    """Verifies a plain password against the bcrypt hash."""
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))

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
    col = get_db()["users"]
    return await col.find_one({"username": username})

async def init_admin_user():
    """Initializes the default admin user on system startup if no admin exists."""
    col = get_db()["users"]
    admin = await col.find_one({"username": settings.ADMIN_USERNAME})
    if not admin:
        hashed = hash_password(settings.ADMIN_DEFAULT_PASSWORD)
        await col.insert_one({
            "username": settings.ADMIN_USERNAME,
            "password_hash": hashed,
            "role": "admin",
            "created_at": datetime.utcnow()
        })
        print(f"[Auth] Initialized default admin user: {settings.ADMIN_USERNAME}")
    else:
        print(f"[Auth] Admin user '{settings.ADMIN_USERNAME}' exists.")

async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)
) -> Dict[str, Any]:
    """Enforces authentication; returns the authenticated user document."""
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

async def validate_ws_token(token: Optional[str] = Query(None)) -> bool:
    """Validates token for WebSocket connection."""
    if not token:
        return False
    try:
        decode_access_token(token)
        return True
    except Exception:
        return False
