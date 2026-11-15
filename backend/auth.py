"""Authentication helpers for the web UI and backwards-compatible bearer clients."""
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
import bcrypt
import jwt
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from pydantic import BaseModel
from config import settings
from database import get_db

security = HTTPBearer(auto_error=False)

class UserLogin(BaseModel):
    username: str
    password: str

def hash_password(password: str) -> str:
    encoded = password.encode('utf-8')
    if len(encoded) > 72:
        raise ValueError('Password must be at most 72 UTF-8 bytes.')
    return bcrypt.hashpw(encoded, bcrypt.gensalt(rounds=12)).decode('utf-8')

def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        encoded = plain_password.encode('utf-8')
        if len(encoded) > 72:
            return False
        return bcrypt.checkpw(encoded, hashed_password.encode('utf-8'))
    except (ValueError, TypeError):
        return False

def create_access_token(data: Dict[str, Any], expires_delta: Optional[timedelta] = None) -> str:
    now = datetime.utcnow()
    to_encode = dict(data)
    to_encode.update({'exp': now + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)), 'iat': now})
    return jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)

def decode_access_token(token: str) -> Dict[str, Any]:
    try:
        return jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM], options={'require':['exp','iat','sub']})
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Invalid or expired authentication token', headers={'WWW-Authenticate':'Bearer'})

async def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    # Fail closed when the database is unavailable. Never fall back to the initial password.
    return await get_db()['users'].find_one({'username': username})

async def init_admin_user():
    col = get_db()['users']
    if await col.find_one({'username': settings.ADMIN_USERNAME}):
        return
    password = settings.ADMIN_DEFAULT_PASSWORD
    if len(password) < 12 or password in {'Admin@Drive2026!', 'change-me-now'}:
        raise RuntimeError('Set ADMIN_DEFAULT_PASSWORD to a unique password of at least 12 characters before first startup.')
    await col.insert_one({'username': settings.ADMIN_USERNAME, 'password_hash': hash_password(password), 'role':'admin', 'created_at': datetime.utcnow()})

async def get_current_user(request: Request, credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)) -> Dict[str, Any]:
    token = credentials.credentials if credentials else request.cookies.get('access_token')
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail='Authentication required', headers={'WWW-Authenticate':'Bearer'})
    payload = decode_access_token(token)
    try:
        user = await get_user_by_username(payload['sub'])
    except Exception:
        raise HTTPException(status_code=503, detail='Authentication database unavailable')
    if not user:
        raise HTTPException(status_code=401, detail='User no longer exists')
    return user

async def get_current_user_flexible(request: Request, credentials: Optional[HTTPAuthorizationCredentials] = Depends(security)) -> Dict[str, Any]:
    return await get_current_user(request, credentials)

async def validate_ws_token(token: Optional[str]) -> Optional[Dict[str, Any]]:
    if not token:
        return None
    try:
        payload = decode_access_token(token)
        return await get_user_by_username(payload['sub'])
    except Exception:
        return None
