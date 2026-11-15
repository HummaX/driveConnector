import os
import re
import json
import asyncio
import httpx
from pathlib import Path
from typing import Optional, Dict, Any, List, Tuple
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from config import settings
from database import (
    upsert_drive_video,
    get_video_by_drive_id,
    get_drive_config_from_db,
    save_drive_config_to_db
)

SCOPES = ['https://www.googleapis.com/auth/drive.readonly']

# In-memory cached active configuration
_ACTIVE_DRIVE_CONFIG: Dict[str, Any] = {
    "auth_type": "none",
    "api_key": "",
    "service_account_json": "",
    "oauth_token": "",
    "folder_id": "",
    "status": "not_configured",
    "last_tested_at": None,
    "last_error": None
}

def extract_drive_id(raw: Optional[str]) -> Optional[str]:
    """
    Extracts a clean Google Drive folder or file ID from either:
    - Raw ID (e.g. '1fK29x...')
    - Standard Folder URL (e.g. 'https://drive.google.com/drive/folders/1fK29x...')
    - Shared Folder URL with user index (e.g. 'https://drive.google.com/drive/u/0/folders/1fK29x...')
    - Open/Id link (e.g. 'https://drive.google.com/open?id=1fK29x...')
    - File link (e.g. 'https://drive.google.com/file/d/1fK29x.../view')
    - Root alias (e.g. 'root' or 'https://drive.google.com/drive/my-drive')
    """
    if not raw:
        return None
    raw_str = str(raw).strip().strip('"').strip("'")
    if not raw_str:
        return None

    # Pattern: /folders/{ID}
    m = re.search(r"folders/([a-zA-Z0-9_-]+)", raw_str)
    if m:
        return m.group(1)

    # Pattern: ?id={ID} or &id={ID}
    m = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", raw_str)
    if m:
        return m.group(1)

    # Pattern: /d/{ID}
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", raw_str)
    if m:
        return m.group(1)

    # Handle my-drive root URL
    if "drive.google.com" in raw_str and "my-drive" in raw_str:
        return "root"

    # Reject non-matching URLs instead of mangling URL text into an ID
    if raw_str.startswith("http://") or raw_str.startswith("https://"):
        return None

    # Direct ID with potential query params
    clean = re.sub(r"[?&#].*$", "", raw_str)
    clean = re.sub(r"[^a-zA-Z0-9_-]", "", clean)
    return clean or None

def mask_api_key(key: Optional[str]) -> Optional[str]:
    """Masks API key for secure UI presentation (e.g. AIzaSy...4a2b)."""
    if not key:
        return None
    k = key.strip()
    if len(k) <= 8:
        return "****"
    return f"{k[:6]}...{k[-4:]}"

def mask_drive_config(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """
    Strips raw secrets and returns public-safe metadata for the UI.
    Guarantees private keys are never exposed in API responses.
    """
    auth_type = cfg.get("auth_type", "none")
    api_key = (cfg.get("api_key") or "").strip()
    sa_json = cfg.get("service_account_json") or ""
    oauth_token = cfg.get("oauth_token") or ""
    folder_id = cfg.get("folder_id") or ""

    has_api_key = bool(api_key or (settings.GOOGLE_API_KEY and settings.GOOGLE_API_KEY.strip()))
    has_sa = False
    sa_email = None
    project_id = None

    if sa_json:
        try:
            sa_dict = json.loads(sa_json) if isinstance(sa_json, str) else sa_json
            if isinstance(sa_dict, dict) and sa_dict.get("type") == "service_account":
                has_sa = True
                sa_email = sa_dict.get("client_email")
                project_id = sa_dict.get("project_id")
        except Exception:
            has_sa = False
    elif os.path.exists(settings.GOOGLE_CREDENTIALS_FILE):
        has_sa = True

    has_oauth = bool(oauth_token or os.path.exists(settings.GOOGLE_TOKEN_FILE))

    configured = has_api_key or has_sa or has_oauth
    status = cfg.get("status")
    if not status or status == "not_configured":
        status = "connected" if configured else "not_configured"

    return {
        "auth_type": auth_type if auth_type != "none" else ("api_key" if has_api_key else ("service_account" if has_sa else "none")),
        "configured": configured,
        "has_api_key": has_api_key,
        "api_key_masked": mask_api_key(api_key or settings.GOOGLE_API_KEY),
        "has_service_account": has_sa,
        "service_account_email": sa_email,
        "project_id": project_id,
        "has_oauth_token": has_oauth,
        "folder_id": folder_id or settings.GOOGLE_DRIVE_FOLDER_ID,
        "status": status,
        "last_tested_at": cfg.get("last_tested_at"),
        "last_error": cfg.get("last_error")
    }

def get_active_drive_config() -> Dict[str, Any]:
    """Returns a copy of current active in-memory configuration."""
    return dict(_ACTIVE_DRIVE_CONFIG)

async def load_drive_config_from_db() -> Dict[str, Any]:
    """Loads configuration from MongoDB into active memory at server startup."""
    global _ACTIVE_DRIVE_CONFIG
    db_cfg = await get_drive_config_from_db()
    if db_cfg:
        _ACTIVE_DRIVE_CONFIG.update(db_cfg)
    else:
        # Check environment variables fallback
        if settings.GOOGLE_API_KEY and settings.GOOGLE_API_KEY.strip():
            _ACTIVE_DRIVE_CONFIG["api_key"] = settings.GOOGLE_API_KEY.strip()
            _ACTIVE_DRIVE_CONFIG["auth_type"] = "api_key"
            _ACTIVE_DRIVE_CONFIG["status"] = "connected"
        if settings.GOOGLE_DRIVE_FOLDER_ID:
            _ACTIVE_DRIVE_CONFIG["folder_id"] = settings.GOOGLE_DRIVE_FOLDER_ID
    return dict(_ACTIVE_DRIVE_CONFIG)

async def get_drive_config() -> Dict[str, Any]:
    """Retrieves active configuration, falling back to MongoDB if memory is blank."""
    if not _ACTIVE_DRIVE_CONFIG.get("api_key") and not _ACTIVE_DRIVE_CONFIG.get("service_account_json"):
        await load_drive_config_from_db()
    return get_active_drive_config()

async def save_drive_config(new_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Saves new credentials to database and active memory.
    Preserves existing credentials if omitted in partial updates.
    """
    global _ACTIVE_DRIVE_CONFIG

    current = await get_drive_config()
    updated = dict(current)

    if new_data.get("clear_credentials"):
        updated["api_key"] = ""
        updated["service_account_json"] = ""
        updated["oauth_token"] = ""
        updated["folder_id"] = ""
        updated["auth_type"] = "none"
        updated["status"] = "not_configured"
        updated["last_tested_at"] = None
        updated["last_error"] = None
    else:
        # Auth type
        if "auth_type" in new_data and new_data["auth_type"]:
            updated["auth_type"] = new_data["auth_type"]

        # API Key
        if "api_key" in new_data and new_data["api_key"] is not None:
            clean_key = str(new_data["api_key"]).strip().strip('"').strip("'")
            if clean_key:
                updated["api_key"] = clean_key
                if not new_data.get("auth_type"):
                    updated["auth_type"] = "api_key"

        # Service Account JSON
        if "service_account_json" in new_data and new_data["service_account_json"] is not None:
            raw_sa = str(new_data["service_account_json"]).strip()
            if raw_sa:
                try:
                    sa_dict = json.loads(raw_sa) if isinstance(raw_sa, str) else raw_sa
                    if not isinstance(sa_dict, dict) or sa_dict.get("type") != "service_account":
                        raise ValueError("Provided JSON is not a valid Google Service Account key.")
                    updated["service_account_json"] = json.dumps(sa_dict)
                    if not new_data.get("auth_type"):
                        updated["auth_type"] = "service_account"
                except Exception as e:
                    raise ValueError(f"Invalid Service Account JSON format: {str(e)}")

        # OAuth Token
        if "oauth_token" in new_data and new_data["oauth_token"] is not None:
            clean_oauth = str(new_data["oauth_token"]).strip()
            if clean_oauth:
                updated["oauth_token"] = clean_oauth
                if not new_data.get("auth_type"):
                    updated["auth_type"] = "oauth"

        # Folder ID / URL
        if "folder_id" in new_data and new_data["folder_id"] is not None:
            updated["folder_id"] = extract_drive_id(new_data["folder_id"]) or ""

    _ACTIVE_DRIVE_CONFIG.update(updated)
    await save_drive_config_to_db(_ACTIVE_DRIVE_CONFIG)
    return dict(_ACTIVE_DRIVE_CONFIG)

def get_drive_service(custom_config: Optional[Dict[str, Any]] = None):
    """
    Initializes and returns an authenticated Google Drive API v3 service.
    Supports:
    1. Google Drive API Key (Fast & simple for shared folders)
    2. Google Service Account JSON (For private drives)
    3. OAuth 2.0 User Token
    4. Local credential files fallback
    """
    cfg = custom_config or _ACTIVE_DRIVE_CONFIG
    auth_type = cfg.get("auth_type")
    api_key = (cfg.get("api_key") or "").strip()
    sa_json = cfg.get("service_account_json") or ""
    oauth_token = cfg.get("oauth_token") or ""

    # Check API Key
    if auth_type == "api_key" or (api_key and not sa_json):
        if api_key:
            return build('drive', 'v3', developerKey=api_key, cache_discovery=False)
        if settings.GOOGLE_API_KEY and settings.GOOGLE_API_KEY.strip():
            return build('drive', 'v3', developerKey=settings.GOOGLE_API_KEY.strip(), cache_discovery=False)

    # Check Service Account JSON in memory/config
    if auth_type == "service_account" or sa_json:
        if sa_json:
            try:
                sa_dict = json.loads(sa_json) if isinstance(sa_json, str) else sa_json
                creds = service_account.Credentials.from_service_account_info(
                    sa_dict, scopes=SCOPES
                )
                return build('drive', 'v3', credentials=creds, cache_discovery=False)
            except Exception as e:
                raise RuntimeError(f"Failed to initialize Service Account: {str(e)}")

    # Check OAuth token in memory/config
    if oauth_token:
        try:
            token_dict = json.loads(oauth_token) if isinstance(oauth_token, str) else oauth_token
            creds = Credentials.from_authorized_user_info(token_dict, SCOPES)
            return build('drive', 'v3', credentials=creds, cache_discovery=False)
        except Exception:
            pass

    # Check Environment API Key
    if settings.GOOGLE_API_KEY and settings.GOOGLE_API_KEY.strip():
        return build('drive', 'v3', developerKey=settings.GOOGLE_API_KEY.strip(), cache_discovery=False)

    # Fallback to local files
    cred_file = settings.GOOGLE_CREDENTIALS_FILE
    token_file = settings.GOOGLE_TOKEN_FILE
    creds = None

    if os.path.exists(cred_file):
        try:
            creds = service_account.Credentials.from_service_account_file(
                cred_file, scopes=SCOPES
            )
            return build('drive', 'v3', credentials=creds, cache_discovery=False)
        except Exception:
            pass

    if os.path.exists(token_file):
        try:
            creds = Credentials.from_authorized_user_file(token_file, SCOPES)
        except Exception:
            pass

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        elif os.path.exists(cred_file):
            try:
                flow = InstalledAppFlow.from_client_secrets_file(cred_file, SCOPES)
                creds = flow.run_local_server(port=0)
                with open(token_file, 'w') as token:
                    token.write(creds.to_json())
            except Exception:
                pass

    if creds:
        return build('drive', 'v3', credentials=creds, cache_discovery=False)

    raise RuntimeError(
        "Google Drive credentials not configured. Please enter your Google API Key or "
        "Service Account JSON in the Drive Sync modal."
    )

def get_auth_headers(service=None) -> Dict[str, str]:
    """
    Safely retrieves Bearer Authorization header for authenticated HTTP asset requests.
    Handles Service Account, OAuth User Credentials, and returns empty dict for API Key.
    """
    if service is None:
        return {}

    creds = getattr(service._http, "credentials", None)
    if not creds:
        return {}

    # Refresh credentials if invalid or expired (works for Service Account & OAuth)
    if hasattr(creds, "refresh") and not getattr(creds, "valid", False):
        try:
            creds.refresh(Request())
        except Exception as e:
            print(f"[DriveCatalog] Warning: Failed to refresh credentials: {e}")

    token = getattr(creds, "token", None)
    if token:
        return {"Authorization": f"Bearer {token}"}
    return {}

def get_drive_download_params(drive_file_id: str) -> Tuple[str, Dict[str, str]]:
    """
    Returns (url, auth_headers) appropriate for the active authentication method.
    Includes supportsAllDrives=true and appends '&key={api_key}' if downloading via API Key.
    """
    auth_headers = {}
    try:
        service = get_drive_service()
        auth_headers = get_auth_headers(service)
    except Exception:
        pass

    config = get_active_drive_config()
    api_key = (config.get("api_key") or settings.GOOGLE_API_KEY or "").strip()

    url = f"https://www.googleapis.com/drive/v3/files/{drive_file_id}?alt=media&supportsAllDrives=true"
    if not auth_headers and api_key:
        url = f"{url}&key={api_key}"

    return url, auth_headers

async def test_drive_connection(test_params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Tests connectivity to Google Drive API v3.
    Accepts provisional credentials to test before saving, or tests active credentials.
    """
    global _ACTIVE_DRIVE_CONFIG

    # Merge provisional test params over active config
    cfg_to_test = dict(_ACTIVE_DRIVE_CONFIG)
    if test_params:
        for k, v in test_params.items():
            if v is not None:
                cfg_to_test[k] = v

    # Extract target folder if provided
    raw_folder = cfg_to_test.get("folder_id")
    target_folder = extract_drive_id(raw_folder)
    auth_method = cfg_to_test.get("auth_type", "api_key")

    try:
        service = get_drive_service(custom_config=cfg_to_test)
        folder_info = None
        folder_msg = ""

        if auth_method == "api_key":
            # API Key connection test:
            # Google Drive API v3 does not permit unscoped listing across user storage with an API key.
            if target_folder and target_folder.lower() != "root":
                try:
                    folder_meta = await asyncio.to_thread(
                        lambda: service.files().get(
                            fileId=target_folder,
                            fields="id, name, mimeType",
                            supportsAllDrives=True
                        ).execute()
                    )
                    folder_info = folder_meta.get("name")
                    folder_msg = f" Verified access to public folder '{folder_info}'."
                except HttpError as folder_err:
                    if folder_err.resp.status in (403, 404):
                        raise
                    raise
            else:
                # Validate API key validity against Drive API by querying a probe file ID
                try:
                    await asyncio.to_thread(
                        lambda: service.files().get(fileId="test_api_key_validity_probe").execute()
                    )
                except HttpError as probe_err:
                    if probe_err.resp.status == 404:
                        # 404 Not Found proves the API key itself is active and recognized by Google Drive API!
                        pass
                    elif probe_err.resp.status == 400 and "API key not valid" in probe_err.content.decode('utf-8', errors='ignore'):
                        raise
                    else:
                        raise
                folder_msg = " API Key is valid and active. Note: Enter a shared Folder Link or ID to catalog videos."
        else:
            # Service Account or OAuth credentials test
            if target_folder and target_folder.lower() != "root":
                try:
                    folder_meta = await asyncio.to_thread(
                        lambda: service.files().get(
                            fileId=target_folder,
                            fields="id, name, mimeType",
                            supportsAllDrives=True
                        ).execute()
                    )
                    folder_info = folder_meta.get("name")
                    folder_msg = f" Verified access to folder '{folder_info}'."
                except Exception:
                    folder_items = await asyncio.to_thread(
                        lambda: service.files().list(
                            q=f"'{target_folder}' in parents and trashed = false",
                            pageSize=1,
                            fields="files(id, name)",
                            supportsAllDrives=True,
                            includeItemsFromAllDrives=True
                        ).execute()
                    )
                    folder_msg = f" Target folder ID '{target_folder}' is accessible."
            else:
                # Test general list access
                results = await asyncio.to_thread(
                    lambda: service.files().list(
                        pageSize=1,
                        fields="files(id, name)",
                        supportsAllDrives=True,
                        includeItemsFromAllDrives=True
                    ).execute()
                )

        success_msg = f"Successfully connected to Google Drive API v3 via {auth_method.replace('_', ' ').title()}!{folder_msg}"

        # Update cached test status
        _ACTIVE_DRIVE_CONFIG["status"] = "connected"
        from datetime import datetime
        _ACTIVE_DRIVE_CONFIG["last_tested_at"] = datetime.utcnow().isoformat()
        _ACTIVE_DRIVE_CONFIG["last_error"] = None

        return {
            "success": True,
            "message": success_msg,
            "auth_type": auth_method,
            "folder_id": target_folder,
            "folder_name": folder_info
        }

    except HttpError as http_err:
        status_code = http_err.resp.status
        try:
            err_details = json.loads(http_err.content.decode('utf-8'))
            detail_msg = err_details.get("error", {}).get("message", str(http_err))
        except Exception:
            detail_msg = str(http_err)

        if "API key not valid" in detail_msg:
            friendly_err = "The Google Drive API key entered is invalid or inactive. Please verify it in Google Cloud Console."
        elif "Google Drive API has not been used" in detail_msg or "it is disabled" in detail_msg:
            friendly_err = "Google Drive API is not enabled in your Google Cloud Project. Please enable it in the APIs & Services Library."
        elif status_code in (403, 404) and auth_method == "api_key":
            if target_folder:
                friendly_err = f"Google Drive folder '{target_folder}' could not be accessed ({status_code}). Ensure the folder's General access is set to 'Anyone with the link' (Viewer)."
            else:
                friendly_err = f"Google Drive API returned {status_code}: {detail_msg}. For API Key, provide a folder shared as 'Anyone with the link can view'."
        elif status_code in (403, 404) and auth_method == "service_account":
            if target_folder:
                friendly_err = f"Google Drive folder '{target_folder}' not found or access denied. Ensure the folder is shared with your Service Account email."
            else:
                friendly_err = f"Service Account returned {status_code}: {detail_msg}"
        elif status_code == 403:
            friendly_err = f"Google Drive API returned 403 Forbidden: {detail_msg}. Ensure proper permissions are granted."
        elif status_code == 404:
            friendly_err = f"Google Drive folder '{target_folder}' was not found. Please verify the link or ID."
        else:
            friendly_err = f"Google Drive API error ({status_code}): {detail_msg}"

        _ACTIVE_DRIVE_CONFIG["status"] = "error"
        _ACTIVE_DRIVE_CONFIG["last_error"] = friendly_err
        return {
            "success": False,
            "message": friendly_err,
            "status_code": status_code
        }

    except Exception as e:
        err_str = str(e)
        _ACTIVE_DRIVE_CONFIG["status"] = "error"
        _ACTIVE_DRIVE_CONFIG["last_error"] = err_str
        return {
            "success": False,
            "message": f"Connection failed: {err_str}"
        }

async def download_drive_thumbnail(
    thumbnail_link: str,
    target_path: Path,
    auth_headers: Dict[str, str]
) -> bool:
    """
    Downloads Google Drive video thumbnail and saves locally.
    Upgrades thumbnail resolution from default 220px to 1280px high-definition poster.
    Falls back to base thumbnail link if HD version is not generated.
    """
    if not thumbnail_link:
        return False

    high_res_link = re.sub(r'=s\d+$', '=s1280', thumbnail_link)
    if '=s' not in high_res_link:
        high_res_link += '=s1280'

    try:
        async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as client:
            resp = await client.get(high_res_link, headers=auth_headers)
            if resp.status_code != 200:
                # Fallback to standard thumbnail
                resp = await client.get(thumbnail_link, headers=auth_headers)
            if resp.status_code != 200 and auth_headers:
                # Fallback to unauthenticated request (Google CDN often blocks Bearer auth on thumbnails)
                resp = await client.get(thumbnail_link)

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
    Supports subfolder traversal when a folder is specified.
    """
    service = get_drive_service()
    auth_headers = get_auth_headers(service)

    raw_folder = folder_id or _ACTIVE_DRIVE_CONFIG.get("folder_id") or settings.GOOGLE_DRIVE_FOLDER_ID
    target_folder = extract_drive_id(raw_folder)
    config = get_active_drive_config()
    auth_type = config.get("auth_type", "api_key")

    if auth_type == "api_key" and (not target_folder or target_folder.lower() == "root"):
        raise ValueError(
            "Google Drive API Key requires a target folder. "
            "Please provide a Google Drive Folder Link or ID shared as 'Anyone with the link can view'."
        )

    folders_to_scan = [target_folder] if (target_folder and target_folder.lower() != "root") else [None]
    visited_folders = set(folders_to_scan)
    total_found = 0
    synced_items = []

    while folders_to_scan:
        current_folder = folders_to_scan.pop(0)

        # 1. Query videos inside current folder
        query_parts = ["mimeType contains 'video/'", "trashed = false"]
        if current_folder:
            sanitized = re.sub(r"[^a-zA-Z0-9_-]", "", current_folder.strip())
            if sanitized:
                query_parts.append(f"'{sanitized}' in parents")

        q_videos = " and ".join(query_parts)
        page_token = None

        while True:
            results = await asyncio.to_thread(
                lambda: service.files().list(
                    q=q_videos,
                    pageSize=100,
                    fields="nextPageToken, files(id, name, size, mimeType, thumbnailLink, hasThumbnail)",
                    pageToken=page_token,
                    supportsAllDrives=True,
                    includeItemsFromAllDrives=True
                ).execute()
            )

            files = results.get('files', [])
            for file in files:
                file_id = file.get('id')
                title = file.get('name', 'Untitled Video')
                file_size = int(file.get('size', 0))
                thumb_link = file.get('thumbnailLink')

                total_found += 1

                # Consistent UUID preservation
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

        # 2. Check for child subfolders if scanning a target folder
        if current_folder and len(visited_folders) < 100:
            sanitized_parent = re.sub(r"[^a-zA-Z0-9_-]", "", current_folder.strip())
            if sanitized_parent:
                q_subfolders = f"mimeType = 'application/vnd.google-apps.folder' and '{sanitized_parent}' in parents and trashed = false"
                sf_page_token = None
                while True:
                    sf_results = await asyncio.to_thread(
                        lambda: service.files().list(
                            q=q_subfolders,
                            pageSize=50,
                            fields="nextPageToken, files(id, name)",
                            pageToken=sf_page_token,
                            supportsAllDrives=True,
                            includeItemsFromAllDrives=True
                        ).execute()
                    )

                    for sf in sf_results.get('files', []):
                        sf_id = sf.get('id')
                        if sf_id and sf_id not in visited_folders and len(visited_folders) < 100:
                            visited_folders.add(sf_id)
                            folders_to_scan.append(sf_id)

                    sf_page_token = sf_results.get('nextPageToken')
                    if not sf_page_token or len(visited_folders) >= 100:
                        break

    return {
        "status": "success",
        "total_cataloged": total_found,
        "items": synced_items
    }
