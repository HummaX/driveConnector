import os
from pathlib import Path
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # MongoDB Config
    MONGODB_URL: str = "mongodb://admin:secretpassword@localhost:27017/media_db?authSource=admin"
    DATABASE_NAME: str = "media_db"

    # OVHcloud Block Storage Paths
    STORAGE_DIR: str = "/mnt/storage"

    # Google Drive API Config
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
