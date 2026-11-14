import os
from pathlib import Path
from typing import List, Optional
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # MongoDB Config
    MONGODB_URL: str = "mongodb://admin:secretpassword@localhost:27017/media_db?authSource=admin"
    DATABASE_NAME: str = "media_db"

    # Mongo Express Web UI
    MONGO_EXPRESS_BIND: str = "127.0.0.1"
    MONGO_EXPRESS_PORT: int = 8081
    MONGO_EXPRESS_USER: str = "admin"
    MONGO_EXPRESS_PASS: str = "expresspassword"

    # OVHcloud Block Storage Paths
    STORAGE_DIR: str = "/mnt/storage"

    # Authentication & JWT
    JWT_SECRET_KEY: str = "drive-connector-super-secret-key-2026-prod"
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days
    ADMIN_USERNAME: str = "admin"
    ADMIN_DEFAULT_PASSWORD: str = "Admin@Drive2026!"

    # Process Governance & CPU Core Reservation
    MAX_CONCURRENT_FFMPEG: int = 2
    MIN_FREE_DISK_BYTES: int = 1024 * 1024 * 1024  # 1 GB reserve
    RESERVED_CPU_CORES: int = 1
    FFMPEG_THREADS: Optional[int] = None

    # CORS
    CORS_ORIGINS: List[str] = ["*"]

    # Google Drive API Config
    GOOGLE_API_KEY: str = ""
    GOOGLE_CREDENTIALS_FILE: str = "credentials.json"
    GOOGLE_TOKEN_FILE: str = "token.json"
    GOOGLE_DRIVE_FOLDER_ID: str = ""

    # Host & Port
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"

    @property
    def ffmpeg_worker_threads(self) -> int:
        """
        Dynamically calculates available CPU cores for video work,
        ensuring RESERVED_CPU_CORES (default 1) is always spared for
        FastAPI web handling, MongoDB, SSH, and system tasks.
        Example: On an 8-core server, allocates 7 cores to video processing.
        """
        if self.FFMPEG_THREADS is not None and self.FFMPEG_THREADS > 0:
            return self.FFMPEG_THREADS
        try:
            total = os.cpu_count() or 1
        except Exception:
            total = 1
        return max(1, total - self.RESERVED_CPU_CORES)

    @property
    def videos_dir(self) -> Path:
        p = Path(self.STORAGE_DIR) / "videos"
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def metadata_dir(self) -> Path:
        p = Path(self.STORAGE_DIR) / "metadata"
        p.mkdir(parents=True, exist_ok=True)
        return p

    def get_video_metadata_dir(self, video_id: str) -> Path:
        p = self.metadata_dir / video_id
        p.mkdir(parents=True, exist_ok=True)
        return p

settings = Settings()
