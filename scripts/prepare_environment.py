#!/usr/bin/env python3
"""Fail-closed checks for the owner-run deployment helper; never sources dotenv."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import sys
from urllib.parse import urlsplit

REQUIRED = ('STORAGE_DIR', 'MONGO_INITDB_ROOT_USERNAME', 'MONGO_INITDB_ROOT_PASSWORD',
            'MONGO_INITDB_DATABASE', 'MONGO_EXPRESS_USER', 'MONGO_EXPRESS_PASS',
            'JWT_SECRET_KEY', 'ADMIN_USERNAME', 'ADMIN_DEFAULT_PASSWORD', 'JDOWNLOADER_PASSWORD')
SECRET_KEYS = ('MONGO_INITDB_ROOT_PASSWORD', 'MONGO_EXPRESS_PASS', 'JWT_SECRET_KEY',
               'ADMIN_DEFAULT_PASSWORD', 'JDOWNLOADER_PASSWORD')
MONGO_KEYS = REQUIRED[1:4]
BAD = {'secretpassword', 'expresspassword', 'drive-connector-super-secret-key-2026-prod',
       'Admin@Drive2026!', 'admin123'}
CONTAINERS = {'mongodb': 'media_mongodb', 'backend': 'media_backend', 'media-worker': 'media_worker',
              'mongo-express': 'media_mongo_express', 'jdownloader': 'media_jdownloader',
              'nginx': 'media_nginx'}
PROJECT = 'driveconnector'
MARGIN_KIB = 102400


def entries(text):
    data = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        m = re.fullmatch(r'''([A-Za-z_][A-Za-z0-9_]*)=([^\s#'"$\\`]*)''', line)
        if not m or m[1] in data:
            raise ValueError('ambiguous or duplicate environment entry; use unquoted KEY=value lines')
        if m[1].startswith(('COMPOSE_', 'DOCKER_', 'GIT_')):
            raise ValueError('deployment control settings are not permitted in dotenv')
        data[m[1]] = m[2]
    return data


def canonical_directory(value):
    path = Path(value)
    if (not path.is_absolute() or str(path) != os.path.realpath(path)
            or path == Path(path.anchor) or not path.is_dir()):
        raise ValueError('expected an existing canonical absolute directory')
    return path


def validate(data):
    for key in REQUIRED:
        if not data.get(key):
            raise ValueError('missing required setting: ' + key)
    for key in SECRET_KEYS:
        if data[key] in BAD:
            raise ValueError('unsafe legacy default in ' + key)
    for key in MONGO_KEYS:
        if not re.fullmatch(r'[A-Za-z0-9_.~-]+', data[key]):
            raise ValueError('Mongo URL setting contains unsupported characters: ' + key)
    canonical_directory(data['STORAGE_DIR'])
    return data


def regular(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('expected a regular, unlinked configuration file')
    return info


def load(path):
    regular(path)
    return validate(entries(path.read_text(encoding='utf-8')))


def initialize(path, template):
    regular(template)
    text = template.read_text(encoding='utf-8')
    data = entries(text)
    for key in SECRET_KEYS:
        if data.get(key) != '':
            raise ValueError('fresh template must contain each secret exactly once and blank')
        value = secrets.token_urlsafe(48)
        text = re.sub(r'^' + key + r'=$', key + '=' + value, text, flags=re.M)
    # Validate everything before exclusive creation, not after leaving an invalid .env.
    validate(entries(text))
    exclusive_write(path, text.encode('utf-8'))


def exclusive_write(path, content):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def fingerprint(path):
    before = regular(path)
    content = path.read_bytes()
    after = regular(path)
    fields = ('st_dev', 'st_ino', 'st_uid', 'st_gid', 'st_mode', 'st_size', 'st_mtime_ns')
    if any(getattr(before, k) != getattr(after, k) for k in fields):
        raise ValueError('configuration changed while reading')
    result = {k: getattr(after, k) for k in fields}
    result['sha256'] = hashlib.sha256(content).hexdigest()
    return content, result


def backup_environment(path, directory):
    load(path)
    content, info = fingerprint(path)
    exclusive_write(directory / '.env', content)
    exclusive_write(directory / 'env-metadata.json', json.dumps(info).encode('ascii'))
    # fsync the directory on POSIX; Windows has no directory fsync API here.
    if os.name == 'posix':
        fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def unchanged(path, directory):
    content, info = fingerprint(path)
    if (content != (directory / '.env').read_bytes()
            or info != json.loads((directory / 'env-metadata.json').read_text())):
        raise ValueError('.env bytes or identity/ownership/mode changed; investigate manually')


def empty_database(storage):
    path = storage / 'mongodb'
    try:
        info = path.lstat()
    except FileNotFoundError:
        return True
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('MongoDB storage must be a plain directory')
    # Never treat a failed listing (including EACCES) as an empty directory.
    with os.scandir(path) as items:
        return next(items, None) is None


def overlaps(a, b):
    return a == b or a in b.parents or b in a.parents


def paths(storage, backup, root):
    backup = canonical_directory(str(backup))
    if overlaps(backup, root) or backup == storage or storage in backup.parents:
        raise ValueError('backup directory must be outside checkout and storage')


def git(*args):
    result = subprocess.run(['git', *args], capture_output=True, text=True)
    if result.returncode:
        raise ValueError('Git inspection failed; no remote operation attempted')
    return result.stdout.rstrip('\n')


def repository(root):
    if Path(git('rev-parse', '--show-toplevel')).resolve() != root.resolve():
        raise ValueError('not the expected repository root')
    if Path(git('rev-parse', '--git-common-dir')).resolve() != (root / '.git').resolve():
        raise ValueError('linked worktrees are unsupported')
    if git('worktree', 'list', '--porcelain').count('worktree ') != 1:
        raise ValueError('repositories with additional worktrees are unsupported')
    if git('symbolic-ref', '--quiet', '--short', 'HEAD') != 'claude-code':
        raise ValueError('checkout must already be on claude-code')
    if git('status', '--porcelain', '--untracked-files=all'):
        raise ValueError('tracked or untracked changes detected; resolve manually')
    if git('ls-files', '--', '.env'):
        raise ValueError('.env must not be tracked')
    for name in ('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'):
        if (root / '.git' / name).exists():
            raise ValueError('unfinished Git operation; resolve manually')


def fetch_url():
    # Use the raw URL, never a credential-bearing rewritten URL or named remote.
    url = git('config', '--get-all', 'remote.origin.url')
    parsed = urlsplit(url)
    if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or parsed.query or parsed.fragment
            or parsed.port not in (None, 443) or not parsed.path.endswith('.git')
            or not re.fullmatch(r'https://[A-Za-z0-9.-]+(?::443)?/[A-Za-z0-9_./-]+\.git', url)
            or '..' in parsed.path.split('/')):
        raise ValueError('origin must have one token-free HTTPS .git URL; configure it manually')
    result = subprocess.run(['git', 'config', '--get-regexp',
                             r'^(url\..*\.(insteadof|pushinsteadof)|http(\..*)?\.(extraheader|proxy)|core\.gitproxy)$'],
                            capture_output=True, text=True)
    if result.returncode != 1:
        raise ValueError('Git URL rewrites, headers or proxies are unsupported; no fetch attempted')
    return url


def incoming(remote):
    if git('ls-tree', '--name-only', remote, '--', '.env'):
        raise ValueError('incoming branch tracks .env')
    changed = git('diff', '--no-renames', '--name-only', '-z', 'HEAD', remote).split('\0')
    ignored = git('ls-files', '--others', '--ignored', '--exclude-standard', '-z').split('\0')
    for a in filter(None, changed):
        for b in filter(None, ignored):
            if a == b or a.startswith(b + '/') or b.startswith(a + '/'):
                raise ValueError('ignored file conflicts with incoming update; resolve manually')


def compose_config(config, env):
    referenced = set(re.findall(r'\$\{([A-Za-z_][A-Za-z0-9_]*)', Path('docker-compose.yml').read_text()))
    for key in referenced | set(env):
        if key in os.environ:
            raise ValueError('unset ambient Compose setting: ' + key)
    services = config.get('services', {})
    if config.get('name') != PROJECT or set(services) != set(CONTAINERS):
        raise ValueError('unexpected Compose project or services')
    for service, name in CONTAINERS.items():
        if services[service].get('container_name') != name:
            raise ValueError('unexpected Compose container name')
    db = services['mongodb']
    mounts = [v for v in db.get('volumes', []) if v.get('target') == '/data/db']
    expected = Path(env['STORAGE_DIR']) / 'mongodb'
    if (len(mounts) != 1 or mounts[0].get('type') != 'bind'
            or Path(mounts[0].get('source', '')).resolve() != expected):
        raise ValueError('conflicting or unexpected MongoDB Compose mount')
    if any(db.get('environment', {}).get(k) != env[k] for k in MONGO_KEYS):
        raise ValueError('Compose MongoDB credentials differ from .env')
    url = ('mongodb://{MONGO_INITDB_ROOT_USERNAME}:{MONGO_INITDB_ROOT_PASSWORD}'
           '@mongodb:27017/{MONGO_INITDB_DATABASE}?authSource=admin').format(**env)
    for service in ('backend', 'media-worker'):
        app_env = services[service].get('environment', {})
        if app_env.get('MONGODB_URL') != url or app_env.get('DATABASE_NAME') != env['MONGO_INITDB_DATABASE']:
            raise ValueError('Compose application database configuration differs from .env')
        for key in ('JWT_SECRET_KEY', 'ADMIN_USERNAME', 'ADMIN_DEFAULT_PASSWORD', 'STORAGE_DIR'):
            if app_env.get(key) != env[key]:
                raise ValueError('Compose application configuration differs from .env: ' + key)
    # Retain only the non-secret image identity needed to check the live database.
    return db.get('image')


def owned(container, service, root):
    labels = container.get('Config', {}).get('Labels') or {}
    return (labels.get('com.docker.compose.project') == PROJECT
            and labels.get('com.docker.compose.service') == service
            and Path(labels.get('com.docker.compose.project.working_dir', '')).resolve() == root.resolve())


def inventory(containers, env, root, fresh, image):
    dbpath = Path(env['STORAGE_DIR']) / 'mongodb'
    dbs = [c for c in containers if c.get('Name') == '/media_mongodb']
    if len(dbs) > 1:
        raise ValueError('ambiguous MongoDB inventory')
    db = dbs[0] if dbs else None
    networks = set((db or {}).get('NetworkSettings', {}).get('Networks', {}))
    for c in containers:
        if c is db:
            continue
        running = c.get('State', {}).get('Running')
        service = next((s for s, n in CONTAINERS.items() if c.get('Name') == '/' + n), None)
        if service and not owned(c, service, root):
            raise ValueError('application container belongs to another checkout or project')
        sharing = any(m.get('Type') == 'bind' and overlaps(Path(m.get('Source', '')).resolve(), dbpath)
                      for m in c.get('Mounts', []))
        connected = networks.intersection(c.get('NetworkSettings', {}).get('Networks', {}))
        if (sharing and (running or not service)) or (running and connected):
            raise ValueError('other database/storage/network users exist; quiesce them manually')
    if db is None:
        if not empty_database(Path(env['STORAGE_DIR'])):
            raise ValueError('MongoDB data exists without a running container; recover original configuration')
        if not fresh:
            raise ValueError('no running MongoDB container; --init only permits proven empty storage')
        return False
    if fresh:
        raise ValueError('--init cannot be used with an existing MongoDB container; use normal update')
    if not owned(db, 'mongodb', root) or not db.get('State', {}).get('Running'):
        raise ValueError('MongoDB is stopped or belongs to another checkout/project')
    mounts = [m for m in db.get('Mounts', []) if m.get('Destination') == '/data/db']
    if (len(mounts) != 1 or mounts[0].get('Type') != 'bind'
            or Path(mounts[0].get('Source', '')).resolve() != dbpath):
        raise ValueError('running MongoDB storage mount mismatch')
    if db.get('Config', {}).get('Image') != image:
        raise ValueError('MongoDB image changes require a separately reviewed migration')
    actual = dict(x.split('=', 1) for x in db.get('Config', {}).get('Env', []) if '=' in x)
    if any(actual.get(k) != env[k] for k in MONGO_KEYS):
        raise ValueError('running MongoDB credentials differ from .env; investigate manually')
    return True


def ready(containers, root):
    for service, name in CONTAINERS.items():
        matches = [c for c in containers if c.get('Name') == '/' + name]
        if len(matches) != 1 or not owned(matches[0], service, root):
            raise ValueError('missing or foreign application container')
        state = matches[0].get('State', {})
        if not state.get('Running') or state.get('Restarting') or state.get('Dead'):
            raise ValueError('application container is not running')
        if 'Health' in state and state['Health'].get('Status') != 'healthy':
            raise ValueError('application container is not healthy')


def space(used, backup_free, storage_free):
    if any(not re.fullmatch('[0-9]+', str(n)) for n in (used, backup_free, storage_free)):
        raise ValueError('cannot determine filesystem capacity')
    if int(backup_free) <= int(used) * 2 + MARGIN_KIB or int(storage_free) <= MARGIN_KIB:
        raise ValueError('insufficient backup or storage free space')


def main():
    p = argparse.ArgumentParser()
    p.add_argument('command', choices=['validate', 'init', 'storage', 'template-storage', 'repository',
                   'fetch-url', 'incoming', 'empty', 'fresh-inventory', 'paths', 'backup', 'unchanged', 'config',
                   'inventory', 'ready', 'space', 'archive', 'health'])
    p.add_argument('args', nargs='*')
    p.add_argument('--template', type=Path)
    args = p.parse_args()
    cmd, a = args.command, args.args
    if cmd == 'init':
        if not args.template:
            raise ValueError('template required')
        initialize(Path(a[0]), args.template)
    elif cmd in ('validate', 'storage'):
        data = load(Path(a[0]))
        if cmd == 'storage':
            print(data['STORAGE_DIR'])
    elif cmd == 'template-storage':
        regular(Path(a[0]))
        print(canonical_directory(entries(Path(a[0]).read_text(encoding='utf-8'))['STORAGE_DIR']))
    elif cmd == 'repository':
        repository(Path(a[0]))
    elif cmd == 'fetch-url':
        print(fetch_url())
    elif cmd == 'incoming':
        incoming(a[0])
    elif cmd == 'empty':
        if not empty_database(Path(a[0])):
            raise ValueError('existing MongoDB data; recover its original credentials')
    elif cmd == 'fresh-inventory':
        inventory(json.load(sys.stdin), {'STORAGE_DIR': a[0]}, Path(a[1]), True, None)
    elif cmd == 'paths':
        paths(Path(a[0]), Path(a[1]), Path(a[2]))
    elif cmd in ('backup', 'unchanged'):
        (backup_environment if cmd == 'backup' else unchanged)(Path(a[0]), Path(a[1]))
    elif cmd == 'config':
        print(compose_config(json.load(sys.stdin), load(Path(a[0]))))
    elif cmd == 'inventory':
        print(int(inventory(json.load(sys.stdin), load(Path(a[0])), Path(a[1]), a[2] == '1', a[3])))
    elif cmd == 'ready':
        ready(json.load(sys.stdin), Path(a[0]))
    elif cmd == 'space':
        space(*a)
    elif cmd == 'archive':
        with gzip.open(a[0], 'rb') as stream:
            if stream.read(4) != b'\x6d\xe2\x99\x81':
                raise ValueError('backup is not a MongoDB archive')
            while stream.read(1024 * 1024):
                pass  # Verify the complete gzip stream/CRC, not just its header.
    elif cmd == 'health':
        data = json.load(sys.stdin)
        if any(data.get(key) != value for key, value in
               (('status', 'ok'), ('app', 'drive_connector'), ('database', 'ok'), ('worker', 'ok'))):
            raise ValueError('unexpected application readiness response')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, IndexError, TypeError) as exc:
        # Never include external command output, dotenv values or container Env in errors.
        print('Deployment check failed:', exc, file=sys.stderr)
        sys.exit(1)
