import uuid
from datetime import datetime
from typing import Optional, List, Dict, Any
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
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)

def get_db() -> AsyncIOMotorDatabase:
    if db is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")
    return db

def get_videos_collection() -> AsyncIOMotorCollection:
    return get_db()["videos"]

async def init_db():
    global client, db
    client = AsyncIOMotorClient(settings.MONGODB_URL)
    db = client[settings.DATABASE_NAME]
    
    # Initialize indexes
    videos_col = db["videos"]
    await videos_col.create_index("video_id", unique=True)
    await videos_col.create_index("drive_file_id", sparse=True)
    await videos_col.create_index("status")
    await videos_col.create_index("created_at")

async def close_db():
    global client
    if client:
        client.close()

async def list_videos(status: Optional[str] = None, search: Optional[str] = None) -> List[Dict[str, Any]]:
    query: Dict[str, Any] = {}
    if status:
        query["status"] = status
    if search:
        query["title"] = {"$regex": search, "$options": "i"}

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
    poster_url: Optional[str] = None
) -> Dict[str, Any]:
    col = get_videos_collection()
    existing = await col.find_one({"drive_file_id": drive_file_id})
    now = datetime.utcnow()

    if existing:
        update_fields: Dict[str, Any] = {
            "title": title,
            "file_size_bytes": file_size_bytes,
            "updated_at": now
        }
        if poster_url and not existing.get("poster_url"):
            update_fields["poster_url"] = poster_url
        await col.update_one({"drive_file_id": drive_file_id}, {"$set": update_fields})
        return await col.find_one({"drive_file_id": drive_file_id}, {"_id": 0})
    else:
        new_video = VideoModel(
            title=title,
            source="GDRIVE",
            drive_file_id=drive_file_id,
            file_size_bytes=file_size_bytes,
            status="REMOTE_ONLY",
            poster_url=poster_url,
            created_at=now,
            updated_at=now
        )
        doc = new_video.model_dump()
        await col.insert_one(doc)
        doc.pop("_id", None)
        return doc

async def create_url_video(url: str, title: Optional[str] = None) -> Dict[str, Any]:
    col = get_videos_collection()
    now = datetime.utcnow()
    new_video = VideoModel(
        title=title or url.split("/")[-1].split("?")[0] or "External Video",
        source="URL",
        url=url,
        file_size_bytes=0,
        status="DOWNLOADING",
        created_at=now,
        updated_at=now
    )
    doc = new_video.model_dump()
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
