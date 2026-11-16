import os
from pathlib import Path
from typing import List, Optional
from pydantic_settings import BaseSettings
from pydantic import field_validator
from urllib.parse import unquote, urlsplit

class Settings(BaseSettings):
    # MongoDB Config
    MONGODB_URL: str = ""
    DATABASE_NAME: str = "media_db"

    # Mongo Express Web UI
    MONGO_EXPRESS_BIND: str = "127.0.0.1"
    MONGO_EXPRESS_PORT: int = 8081
    MONGO_EXPRESS_USER: str = "admin"
    MONGO_EXPRESS_PASS: str = ""

    # OVHcloud Block Storage Paths
    STORAGE_DIR: str = "/mnt/storage"

    # Authentication & JWT
    JWT_SECRET_KEY: str = ""
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60 * 24 * 7  # 7 days
    ADMIN_USERNAME: str = "admin"
    ADMIN_DEFAULT_PASSWORD: str = ""
    ENABLE_EXTERNAL_URLS: bool = False

    # Process governance hints; these thread counts are not OS-enforced limits.
    MAX_CONCURRENT_FFMPEG: int = 4
    MIN_FREE_DISK_BYTES: int = 1024 * 1024 * 1024  # 1 GB reserve
    RESERVED_CPU_CORES: int = 1
    FFMPEG_THREADS: Optional[int] = None
    WHISPER_CPU_RATIO: float = 0.80  # Target 80% CPU utilization for AI subtitles

    # RAM profile estimates; not enforced allocations or a host reservation.
    TOTAL_RAM_GB: float = 32.0
    RESERVED_RAM_RATIO: float = 0.10  # planning estimate, not a reservation
    CLOUD_PIPELINE_RAM_RATIO: float = 0.90  # 90% allocated to Cloud Pipeline (~28.8 GB)

    # Cloud Pipeline Memory Allocation Shares (sum = 90% of system RAM)
    WHISPER_RAM_RATIO: float = 0.30       # ~9.6 GB for parallel chunk AI transcription pool
    FFMPEG_RAM_RATIO: float = 0.30        # ~9.6 GB for FFmpeg concurrent transcode & sprite buffering
    STREAM_BUFFER_RAM_RATIO: float = 0.15 # ~4.8 GB for chunked video streaming ring buffers
    DOWNLOAD_BUFFER_RAM_RATIO: float = 0.15 # ~4.8 GB for cloud ingestion & direct HTTP buffers

    # High-Throughput Buffer Sizing
    STREAM_CHUNK_SIZE_BYTES: int = 4 * 1024 * 1024     # 4 MB read chunks (accelerates seek & high bitrate streaming)
    STREAM_BURST_CHUNK_SIZE_BYTES: int = 16 * 1024 * 1024   # 16 MB burst chunks (instant progressive start & byte-range streaming)
    DOWNLOAD_CHUNK_SIZE_BYTES: int = 8 * 1024 * 1024   # 8 MB download stream chunks (accelerates Google Drive / URL downloads)

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

    @field_validator("FFMPEG_THREADS", mode="before")
    @classmethod
    def parse_ffmpeg_threads(cls, v):
        if v is None or v == "" or (isinstance(v, str) and not v.strip()):
            return None
        try:
            return int(v)
        except (ValueError, TypeError):
            return None

    @field_validator("RESERVED_CPU_CORES", mode="before")
    @classmethod
    def parse_reserved_cpu_cores(cls, v):
        if v is None or v == "" or (isinstance(v, str) and not v.strip()):
            return 1
        try:
            return max(0, int(v))
        except (ValueError, TypeError):
            return 1

    @field_validator("MAX_CONCURRENT_FFMPEG", mode="before")
    @classmethod
    def parse_max_concurrent_ffmpeg(cls, v):
        if v is None or v == "" or (isinstance(v, str) and not v.strip()):
            return 4
        try:
            return max(1, int(v))
        except (ValueError, TypeError):
            return 4

    def validate_runtime(self):
        """Reject missing/private configuration without changing existing values."""
        if not self.MONGODB_URL or not self.DATABASE_NAME:
            raise RuntimeError("Configure MONGODB_URL and DATABASE_NAME privately before startup.")
        parsed = urlsplit(self.MONGODB_URL)
        if parsed.scheme not in {"mongodb", "mongodb+srv"}:
            raise RuntimeError("MONGODB_URL must use a MongoDB connection scheme.")
        uri_database = unquote(parsed.path.lstrip("/"))
        if uri_database and uri_database != self.DATABASE_NAME:
            raise RuntimeError("MONGODB_URL and DATABASE_NAME disagree; restore the original database selection.")
        if len(self.JWT_SECRET_KEY) < 32:
            raise RuntimeError("Configure the original JWT signing key privately (at least 32 characters).")

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"

    @property
    def ffmpeg_worker_threads(self) -> int:
        """
        Calculates a per-process FFmpeg thread hint from the logical CPU count.
        This neither caps aggregate CPU use nor reserves a physical core.
        Example: on an 8-logical-CPU machine, the default hint is 7 threads.
        """
        if self.FFMPEG_THREADS is not None and self.FFMPEG_THREADS > 0:
            return self.FFMPEG_THREADS
        try:
            total = os.cpu_count() or 1
        except Exception:
            total = 1
        return max(1, total - self.RESERVED_CPU_CORES)

    @property
    def whisper_worker_threads(self) -> int:
        """
        Calculates an AI transcription thread hint from the logical CPU count.
        It does not enforce aggregate utilization or reserve host CPU capacity.
        """
        try:
            total = os.cpu_count() or 1
        except Exception:
            total = 1
        return max(1, int(round(total * self.WHISPER_CPU_RATIO)))

    @property
    def total_ram_bytes(self) -> int:
        try:
            import psutil
            return psutil.virtual_memory().total
        except Exception:
            return int(self.TOTAL_RAM_GB * (1024**3))

    @property
    def total_ram_gb(self) -> float:
        return round(self.total_ram_bytes / (1024**3), 2)

    @property
    def reserved_ram_gb(self) -> float:
        """Estimated host share, not a protected memory reservation."""
        return round(self.total_ram_gb * self.RESERVED_RAM_RATIO, 2)

    @property
    def pipeline_ram_gb(self) -> float:
        """90% distributed across the cloud media pipeline."""
        return round(self.total_ram_gb * self.CLOUD_PIPELINE_RAM_RATIO, 2)

    @property
    def whisper_ram_pool_gb(self) -> float:
        return round(self.total_ram_gb * self.WHISPER_RAM_RATIO, 2)

    @property
    def ffmpeg_ram_pool_gb(self) -> float:
        return round(self.total_ram_gb * self.FFMPEG_RAM_RATIO, 2)

    @property
    def streaming_buffers_ram_gb(self) -> float:
        return round(self.total_ram_gb * self.STREAM_BUFFER_RAM_RATIO, 2)

    @property
    def download_buffers_ram_gb(self) -> float:
        return round(self.total_ram_gb * self.DOWNLOAD_BUFFER_RAM_RATIO, 2)

    @property
    def storage_dir(self) -> Path:
        p = Path(self.STORAGE_DIR)
        p.mkdir(parents=True, exist_ok=True)
        return p

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
