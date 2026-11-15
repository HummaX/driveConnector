import re
import uuid
from datetime import datetime
from typing import Optional, List, Dict, Any
from urllib.parse import urlparse, unquote
from pathlib import Path
from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase, AsyncIOMotorCollection
from pydantic import BaseModel, Field
from config import settings

client: Optional[AsyncIOMotorClient] = None
db: Optional[AsyncIOMotorDatabase] = None

class VideoModel(BaseModel):
    video_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str
    source: str  # "GDRIVE" or "URL"
    drive_file_id: Optional[str] = None
    url: Optional[str] = None
    file_size_bytes: int = 0
    local_path: Optional[str] = None
    status: str = "REMOTE_ONLY"  # "REMOTE_ONLY", "DOWNLOADING", "PROCESSING", "LOCAL_READY", "FAILED"
    duration_seconds: float = 0.0
    poster_url: Optional[str] = None
    preview_url: Optional[str] = None
    vtt_url: Optional[str] = None
    subtitles_url: Optional[str] = None
    renditions: Dict[str, Any] = Field(default_factory=dict)
    processing_info: Optional[Dict[str, Any]] = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

def get_db() -> AsyncIOMotorDatabase:
    if db is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")
    return db

def get_videos_collection() -> AsyncIOMotorCollection:
    return get_db()["videos"]

def get_users_collection() -> AsyncIOMotorCollection:
    return get_db()["users"]

def get_settings_collection() -> AsyncIOMotorCollection:
    return get_db()["settings"]

async def get_drive_config_from_db() -> Optional[Dict[str, Any]]:
    """Retrieves saved Google Drive configuration from MongoDB."""
    try:
        col = get_settings_collection()
        doc = await col.find_one({"_id": "drive_config"})
        return doc
    except Exception as e:
        print(f"[Database] Notice: Could not read drive_config from DB: {e}")
        return None

async def save_drive_config_to_db(config: Dict[str, Any]) -> Dict[str, Any]:
    """Persists Google Drive configuration to MongoDB settings collection."""
    doc_to_save = dict(config)
    doc_to_save["_id"] = "drive_config"
    doc_to_save["updated_at"] = datetime.utcnow()
    try:
        col = get_settings_collection()
        await col.replace_one({"_id": "drive_config"}, doc_to_save, upsert=True)
    except Exception as e:
        print(f"[Database] Notice: Could not write drive_config to DB: {e}")
    return doc_to_save

async def init_db():
    global client, db
    client = AsyncIOMotorClient(
        settings.MONGODB_URL,
        serverSelectionTimeoutMS=5000,
        maxPoolSize=50,
        minPoolSize=5
    )
    db = client[settings.DATABASE_NAME]
    
    # Initialize indexes
    videos_col = db["videos"]
    await videos_col.create_index("video_id", unique=True)
    try:
        await videos_col.update_many({"drive_file_id": None}, {"$unset": {"drive_file_id": ""}})
    except Exception:
        pass
    try:
        await videos_col.drop_index("drive_file_id_1")
    except Exception:
        pass
    await videos_col.create_index(
        "drive_file_id",
        unique=True,
        partialFilterExpression={"drive_file_id": {"$type": "string"}}
    )
    await videos_col.create_index("status")
    await videos_col.create_index("created_at")

    # Auto-unstick videos that have local files but got stuck in PROCESSING
    try:
        await videos_col.update_many(
            {
                "status": "PROCESSING",
                "$or": [
                    {"local_path": {"$ne": None}},
                    {"file_size_bytes": {"$gt": 0}},
                    {"poster_url": {"$ne": None}}
                ]
            },
            {"$set": {"status": "LOCAL_READY", "processing_info": None}}
        )
    except Exception:
        pass

    # Users index
    users_col = db["users"]
    await users_col.create_index("username", unique=True)

async def close_db():
    global client
    if client:
        client.close()

async def list_videos(status: Optional[str] = None, search: Optional[str] = None) -> List[Dict[str, Any]]:
    query: Dict[str, Any] = {}
    if status:
        query["status"] = status
    if search:
        # ReDoS & regex injection protection: escape arbitrary search terms
        safe_search = re.escape(search.strip())
        query["title"] = {"$regex": safe_search, "$options": "i"}

    cursor = get_videos_collection().find(query, {"_id": 0}).sort("created_at", -1)
    return await cursor.to_list(length=1000)

async def get_video(video_id: str) -> Optional[Dict[str, Any]]:
    return await get_videos_collection().find_one({"video_id": video_id}, {"_id": 0})

async def get_video_by_drive_id(drive_file_id: str) -> Optional[Dict[str, Any]]:
    return await get_videos_collection().find_one({"drive_file_id": drive_file_id}, {"_id": 0})

async def upsert_drive_video(
    drive_file_id: str,
    title: str,
    file_size_bytes: int,
    poster_url: Optional[str] = None,
    assigned_video_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Atomic upsert preventing race conditions and duplicate document creation.
    """
    col = get_videos_collection()
    now = datetime.utcnow()
    video_id = assigned_video_id or str(uuid.uuid4())

    set_fields: Dict[str, Any] = {
        "title": title,
        "file_size_bytes": file_size_bytes,
        "updated_at": now
    }
    if poster_url:
        set_fields["poster_url"] = poster_url

    set_on_insert: Dict[str, Any] = {
        "video_id": video_id,
        "source": "GDRIVE",
        "drive_file_id": drive_file_id,
        "status": "REMOTE_ONLY",
        "duration_seconds": 0.0,
        "created_at": now
    }

    await col.update_one(
        {"drive_file_id": drive_file_id},
        {"$set": set_fields, "$setOnInsert": set_on_insert},
        upsert=True
    )
    return await col.find_one({"drive_file_id": drive_file_id}, {"_id": 0})

async def create_url_video(url: str, title: Optional[str] = None) -> Dict[str, Any]:
    col = get_videos_collection()
    now = datetime.utcnow()
    parsed_path = urlparse(url).path
    raw_filename = unquote(parsed_path.split("/")[-1]) if parsed_path else ""
    default_title = Path(raw_filename).stem if raw_filename else "External Video"
    clean_title = (title or default_title or "External Video").strip()
    new_video = VideoModel(
        title=clean_title,
        source="URL",
        url=url,
        file_size_bytes=0,
        status="DOWNLOADING",
        created_at=now,
        updated_at=now
    )
    doc = new_video.model_dump()
    doc.pop("_id", None)
    if not doc.get("drive_file_id"):
        doc.pop("drive_file_id", None)
    await col.insert_one(doc)
    doc.pop("_id", None)
    return doc

async def create_local_scanned_video(file_path: Path) -> Dict[str, Any]:
    col = get_videos_collection()
    now = datetime.utcnow()
    clean_title = file_path.stem
    size_bytes = file_path.stat().st_size if file_path.exists() else 0
    new_video = VideoModel(
        title=clean_title,
        source="LOCAL",
        local_path=str(file_path),
        file_size_bytes=size_bytes,
        status="PROCESSING",
        created_at=now,
        updated_at=now
    )
    doc = new_video.model_dump()
    doc.pop("_id", None)
    doc.pop("drive_file_id", None)
    await col.insert_one(doc)
    doc.pop("_id", None)
    return doc

async def update_video(video_id: str, update_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    update_data["updated_at"] = datetime.utcnow()
    await get_videos_collection().update_one(
        {"video_id": video_id},
        {"$set": update_data}
    )
    return await get_video(video_id)

async def delete_video(video_id: str) -> bool:
    res = await get_videos_collection().delete_one({"video_id": video_id})
    return res.deleted_count > 0
