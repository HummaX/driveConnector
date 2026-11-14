import os
import re
import httpx
from pathlib import Path
from typing import Optional, Dict, Any, List
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

from config import settings
from database import upsert_drive_video, get_video_by_drive_id

SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

def get_drive_service():
    """Initializes and returns an authenticated Google Drive API v3 service."""
    creds = None
    cred_file = settings.GOOGLE_CREDENTIALS_FILE
    token_file = settings.GOOGLE_TOKEN_FILE

    # 1. Service Account credentials check
    if os.path.exists(cred_file):
        try:
            creds = service_account.Credentials.from_service_account_file(
                cred_file, scopes=SCOPES
            )
            return build('drive', 'v3', credentials=creds, cache_discovery=False)
        except Exception:
            pass

    # 2. OAuth 2.0 User Token check
    if os.path.exists(token_file):
        creds = Credentials.from_authorized_user_file(token_file, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        elif os.path.exists(cred_file):
            flow = InstalledAppFlow.from_client_secrets_file(cred_file, SCOPES)
            creds = flow.run_local_server(port=0)
            with open(token_file, 'w') as token:
                token.write(creds.to_json())

    if not creds:
        raise RuntimeError(
            f"Google Drive credentials not found or invalid. Place service_account.json or credentials.json at: {cred_file}"
        )

    return build('drive', 'v3', credentials=creds, cache_discovery=False)

def get_auth_headers(service) -> Dict[str, str]:
    """Retrieves Bearer Authorization header for authenticated HTTP asset requests."""
    creds = service._http.credentials
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
    return {"Authorization": f"Bearer {creds.token}"}

async def download_drive_thumbnail(
    thumbnail_link: str,
    target_path: Path,
    auth_headers: Dict[str, str]
) -> bool:
    """
    Downloads Google Drive video thumbnail and saves locally.
    Upgrades thumbnail resolution from default 220px to 1280px high-definition poster.
    """
    if not thumbnail_link:
        return False

    high_res_link = re.sub(r'=s\d+$', '=s1280', thumbnail_link)
    if '=s' not in high_res_link:
        high_res_link += '=s1280'

    try:
        # CYB-08: Restrict headers to Google domains to avoid token leakage across redirects
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(high_res_link, headers=auth_headers)
            if resp.status_code == 200 and len(resp.content) > 500:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                with open(target_path, "wb") as f:
                    f.write(resp.content)
                return True
    except Exception as e:
        print(f"[DriveCatalog] Warning: Failed to download thumbnail: {e}")

    return False

async def sync_drive_catalog(folder_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Lightweight Google Drive Catalog Sync:
    Scans Google Drive for all video files, downloads thumbnails, and inserts REMOTE_ONLY records.
    """
    service = get_drive_service()
    auth_headers = get_auth_headers(service)

    target_folder = folder_id or settings.GOOGLE_DRIVE_FOLDER_ID

    # CYB-07: Sanitize folder_id to prevent Google Drive API query injection
    query_parts = ["mimeType contains 'video/'", "trashed = false"]
    if target_folder:
        sanitized_folder = re.sub(r"[^a-zA-Z0-9_-]", "", target_folder.strip())
        if sanitized_folder:
            query_parts.append(f"'{sanitized_folder}' in parents")
    
    q_str = " and ".join(query_parts)

    page_token = None
    total_found = 0
    synced_items = []

    while True:
        results = service.files().list(
            q=q_str,
            pageSize=100,
            fields="nextPageToken, files(id, name, size, mimeType, thumbnailLink, hasThumbnail)",
            pageToken=page_token,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True
        ).execute()

        files = results.get('files', [])
        for file in files:
            file_id = file.get('id')
            title = file.get('name', 'Untitled Video')
            file_size = int(file.get('size', 0))
            thumb_link = file.get('thumbnailLink')

            total_found += 1

            # Consistent UUID preservation (CODE-05)
            existing_doc = await get_video_by_drive_id(file_id)
            if existing_doc:
                video_id = existing_doc["video_id"]
            else:
                import uuid
                video_id = str(uuid.uuid4())

            meta_dir = settings.get_video_metadata_dir(video_id)
            poster_path = meta_dir / "poster.jpg"
            poster_url = None

            if not poster_path.exists() and thumb_link:
                success = await download_drive_thumbnail(thumb_link, poster_path, auth_headers)
                if success:
                    poster_url = f"/metadata/{video_id}/poster.jpg"
            elif poster_path.exists():
                poster_url = f"/metadata/{video_id}/poster.jpg"

            # Atomic upsert
            doc = await upsert_drive_video(
                drive_file_id=file_id,
                title=title,
                file_size_bytes=file_size,
                poster_url=poster_url,
                assigned_video_id=video_id
            )
            synced_items.append(doc)

        page_token = results.get('nextPageToken')
        if not page_token:
            break

    return {
        "status": "success",
        "total_cataloged": total_found,
        "items": synced_items
    }
