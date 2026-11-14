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
    """
    Initializes and returns an authenticated Google Drive API v3 service resource.
    Supports either:
    1. Service Account JSON file (recommended for headless servers)
    2. OAuth 2.0 User Token (token.json / credentials.json flow)
    """
    creds = None
    cred_file = settings.GOOGLE_CREDENTIALS_FILE
    token_file = settings.GOOGLE_TOKEN_FILE

    # 1. Check for Service Account credentials first
    if os.path.exists(cred_file):
        try:
            creds = service_account.Credentials.from_service_account_file(
                cred_file, scopes=SCOPES
            )
            return build('drive', 'v3', credentials=creds, cache_discovery=False)
        except Exception:
            # If not a service account JSON, proceed to OAuth client check
            pass

    # 2. Check for OAuth 2.0 User Token
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
    """Retrieves current Bearer Authorization header for authenticated HTTP asset requests."""
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

    # Upgrade low-res thumbnail (=s220) to high-res (=s1280)
    high_res_link = re.sub(r'=s\d+$', '=s1280', thumbnail_link)
    if '=s' not in high_res_link:
        high_res_link += '=s1280'

    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(high_res_link, headers=auth_headers)
            if resp.status_code == 200 and len(resp.content) > 500:
                target_path.parent.mkdir(parents=True, exist_ok=True)
                with open(target_path, "wb") as f:
                    f.write(resp.content)
                return True
    except Exception as e:
        print(f"[DriveCatalog] Warning: Failed to download thumbnail from {high_res_link}: {e}")

    return False

async def sync_drive_catalog(folder_id: Optional[str] = None) -> Dict[str, Any]:
    """
    Scans Google Drive for all video files (WITHOUT downloading the video payloads).
    Extracts filename, size, drive_file_id, and downloads the thumbnail picture.
    Stores records in MongoDB with status: 'REMOTE_ONLY'.
    """
    service = get_drive_service()
    auth_headers = get_auth_headers(service)

    target_folder = folder_id or settings.GOOGLE_DRIVE_FOLDER_ID

    # Construct query: filter only video MIME types and non-trashed files
    query_parts = ["mimeType contains 'video/'", "trashed = false"]
    if target_folder:
        query_parts.append(f"'{target_folder}' in parents")
    
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

            # Check if already present in DB
            existing_doc = await get_video_by_drive_id(file_id)
            if existing_doc:
                video_id = existing_doc["video_id"]
            else:
                import uuid
                video_id = str(uuid.uuid4())

            # Local metadata storage directory: /mnt/storage/metadata/{video_id}/
            meta_dir = settings.get_video_metadata_dir(video_id)
            poster_path = meta_dir / "poster.jpg"
            poster_url = None

            # Download Drive thumbnail if not already present on local disk
            if not poster_path.exists() and thumb_link:
                success = await download_drive_thumbnail(thumb_link, poster_path, auth_headers)
                if success:
                    poster_url = f"/metadata/{video_id}/poster.jpg"
            elif poster_path.exists():
                poster_url = f"/metadata/{video_id}/poster.jpg"

            # Upsert into MongoDB
            doc = await upsert_drive_video(
                drive_file_id=file_id,
                title=title,
                file_size_bytes=file_size,
                poster_url=poster_url
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
