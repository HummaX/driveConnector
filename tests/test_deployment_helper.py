import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]

class DeploymentEnvironmentTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.script = self.root / 'prepare_environment.py'
        shutil.copyfile(ROOT / 'scripts' / 'prepare_environment.py', self.script)
        self.template = self.root / 'example'
        template = (ROOT / '.env.example').read_text(encoding='utf-8')
        template = template.replace('/mnt/storage', self.root.as_posix())
        self.template.write_text(template, encoding='utf-8')
        self.envfile = self.root / 'env'

    def run_helper(self, *args):
        return subprocess.run([sys.executable, '-I', str(self.script), *map(str, args)],
                              capture_output=True, text=True, cwd=self.root)

    def test_fresh_secrets_distinct_and_exclusive(self):
        result = self.run_helper('init', self.envfile, '--template', self.template)
        self.assertEqual(result.returncode, 0, result.stderr)
        values = dict(line.split('=', 1) for line in self.envfile.read_text().splitlines()
                      if '=' in line and not line.startswith('#'))
        keys = ['MONGO_INITDB_ROOT_PASSWORD', 'MONGO_EXPRESS_PASS', 'JWT_SECRET_KEY',
                'ADMIN_DEFAULT_PASSWORD', 'JDOWNLOADER_PASSWORD']
        self.assertEqual(len({values[k] for k in keys}), len(keys))
        original = self.envfile.read_bytes()
        self.assertNotEqual(self.run_helper('init', self.envfile, '--template', self.template).returncode, 0)
        self.assertEqual(self.envfile.read_bytes(), original)

    def test_reject_duplicate_missing_and_unsafe(self):
        self.assertEqual(self.run_helper('init', self.envfile, '--template', self.template).returncode, 0)
        original = self.envfile.read_text()
        self.envfile.write_text(original + '\nJWT_SECRET_KEY=other\n')
        self.assertNotEqual(self.run_helper('validate', self.envfile).returncode, 0)
        self.envfile.write_text(original.replace('MONGO_EXPRESS_PASS=', 'MONGO_EXPRESS_PASS=expresspassword\nIGNORE='))
        self.assertNotEqual(self.run_helper('validate', self.envfile).returncode, 0)
        self.envfile.write_text(original.replace('STORAGE_DIR=', 'STORAGE_DIR=$HOME'))
        self.assertNotEqual(self.run_helper('validate', self.envfile).returncode, 0)

    def test_storage_is_reported_without_secret_output(self):
        self.assertEqual(self.run_helper('init', self.envfile, '--template', self.template).returncode, 0)
        result = self.run_helper('storage', self.envfile)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout.strip(), self.root.as_posix())
        self.assertEqual(result.stderr, '')

# The original three regressions above are deliberately unchanged.
import gzip
import importlib.util
import json
import time
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('deployment_checks', ROOT / 'scripts' / 'prepare_environment.py')
CHECKS = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKS)


class DeploymentCheckTests(DeploymentEnvironmentTests):
    def test_invalid_template_does_not_create_environment(self):
        self.template.write_text(self.template.read_text() + '\nJWT_SECRET_KEY=duplicate\n')
        result = self.run_helper('init', self.envfile, '--template', self.template)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.envfile.exists())

    def test_directory_listing_error_is_not_empty(self):
        (self.root / 'mongodb').mkdir()
        with patch.object(CHECKS.os, 'scandir', side_effect=PermissionError('fixture denied')):
            with self.assertRaises(PermissionError):
                CHECKS.empty_database(self.root)

    def test_database_path_must_be_directory(self):
        (self.root / 'mongodb').write_text('fixture')
        with self.assertRaises(ValueError):
            CHECKS.empty_database(self.root)

    def test_storage_must_exist(self):
        self.template.write_text(self.template.read_text().replace(self.root.as_posix(), (self.root / 'missing').as_posix()))
        self.assertNotEqual(self.run_helper('init', self.envfile, '--template', self.template).returncode, 0)
        self.assertFalse(self.envfile.exists())

    def test_backup_is_byte_exact_and_source_identity_is_preserved(self):
        self.assertEqual(self.run_helper('init', self.envfile, '--template', self.template).returncode, 0)
        self.envfile.write_bytes(self.envfile.read_bytes().replace(b'\n', b'\r\n'))
        before, identity = CHECKS.fingerprint(self.envfile)
        directory = self.root / 'backup'
        directory.mkdir()
        CHECKS.backup_environment(self.envfile, directory)
        CHECKS.unchanged(self.envfile, directory)
        self.assertEqual((directory / '.env').read_bytes(), before)
        self.assertEqual(CHECKS.fingerprint(self.envfile)[1], identity)
        self.envfile.write_bytes(before + b'# changed\r\n')
        with self.assertRaises(ValueError):
            CHECKS.unchanged(self.envfile, directory)

    def test_capacity_is_strict_and_does_not_overflow(self):
        for values in (('bad', '999999', '999999'), ('1', '102402', '999999'),
                       ('1', '999999', '102400'), (str(2**100), '999999999', '999999')):
            with self.subTest(values=values), self.assertRaises(ValueError):
                CHECKS.space(*values)
        CHECKS.space('1', '102403', '102401')

    def test_database_symlink_rejected(self):
        try:
            (self.root / 'mongodb').symlink_to(self.root, target_is_directory=True)
        except OSError:
            self.skipTest('symlink creation is unavailable on this test host')
        with self.assertRaises(ValueError):
            CHECKS.empty_database(self.root)


# Every external deployment command below is intercepted in a temporary PATH.
# The driver never launches Git, Docker, mount, network or privilege commands.
FIXTURE_DRIVER = r'''
import gzip, json, os, pathlib, sys, time
sys.stdout.reconfigure(newline='\n')
root = pathlib.Path(os.environ['DC_FIXTURE'])
flags = json.loads((root / 'flags.json').read_text())
cmd, args = sys.argv[1], sys.argv[2:]
with (root / 'events.jsonl').open('a') as log:
    log.write(json.dumps([cmd, args]) + '\n')
def stop(code=1):
    sys.exit(code)
def output(value):
    print(value)
def vals():
    return dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines()
                if '=' in line and not line.startswith('#'))
names = {'mongodb':'media_mongodb','backend':'media_backend','media-worker':'media_worker',
         'mongo-express':'media_mongo_express', 'jdownloader':'media_jdownloader','nginx':'media_nginx'}
def config():
    e = vals()
    services = {k:{'container_name':v} for k,v in names.items()}
    services['mongodb'].update(image='mongo:7.0', environment={k:v for k,v in e.items() if k.startswith('MONGO_INITDB_')},
        volumes=[{'type':'bind','source':str(pathlib.Path(e['STORAGE_DIR'])/'mongodb'),'target':'/data/db'}])
    app_env = {k:e[k] for k in ('JWT_SECRET_KEY','ADMIN_USERNAME','ADMIN_DEFAULT_PASSWORD','STORAGE_DIR')}
    app_env.update(MONGODB_URL=('mongodb://{MONGO_INITDB_ROOT_USERNAME}:{MONGO_INITDB_ROOT_PASSWORD}@mongodb:27017/{MONGO_INITDB_DATABASE}?authSource=admin').format(**e), DATABASE_NAME=e['MONGO_INITDB_DATABASE'])
    for service in ('backend','media-worker'): services[service]['environment'] = dict(app_env)
    if flags.get('updated_config_bad') and (root/'UPDATED').exists():
        services['mongodb']['volumes'][0]['source'] = str(root/'wrong')
    if flags.get('ambient_config'):
        services['mongodb']['environment']['MONGO_INITDB_ROOT_PASSWORD']='other'
    return {'name':'driveconnector','services':services}
def containers():
    started = (root/'STARTED').exists()
    existing = flags.get('existing', True)
    services = list(names) if started else (['mongodb'] if existing else [])
    result=[]
    e=vals() if (root/'.env').exists() else {'STORAGE_DIR':str(root.parent/'storage')}
    for index, s in enumerate(services, 1):
        env=[k+'='+v for k,v in e.items() if k.startswith('MONGO_INITDB_')]
        if flags.get('credentials_mismatch') and s=='mongodb':
            env=['MONGO_INITDB_ROOT_USERNAME=other','MONGO_INITDB_ROOT_PASSWORD=other','MONGO_INITDB_DATABASE=other']
        labels={'com.docker.compose.project':'driveconnector','com.docker.compose.service':s,
                'com.docker.compose.project.working_dir':str(root)}
        if flags.get('foreign_project'):
            labels['com.docker.compose.project']='other'
        source = str(pathlib.Path(e['STORAGE_DIR'])/'mongodb')
        if flags.get('mount_mismatch'):
            source = str(root/'other-storage')
        state={'Running':not flags.get('stopped'), 'Restarting':False}
        if s=='mongodb': state['Health']={'Status':'healthy'}
        if started and flags.get('unhealthy') and s=='backend': state['Health']={'Status':'unhealthy'}
        result.append({'Id':format(index,'064x'),'Name':'/'+names[s],'State':state,
            'Config':{'Env':env,'Labels':labels,'Image':'mongo:7.0' if s=='mongodb' else 'fixture'},
            'Mounts':[{'Type':'bind','Source':source,'Destination':'/data/db'}] if s=='mongodb' else [],
            'NetworkSettings':{'Networks':{'fixture-net':{}}}})
    if flags.get('concurrent_container'):
        result.append({'Id':'f'*64,'Name':'/other-db-client','State':{'Running':True},
                       'Mounts':[{'Type':'bind','Source':str(pathlib.Path(e['STORAGE_DIR'])),'Destination':'/shared'}]})
    return result
if cmd=='git':
    while args and args[0]=='-c': args=args[2:]
    if args[:2]==['rev-parse','--show-toplevel']: output(str(root))
    elif args[:2]==['rev-parse','--git-common-dir']: output(str(root/'.git'))
    elif args[:2]==['worktree','list']:
        output('worktree '+str(root)+'\nHEAD '+'a'*40+'\nbranch refs/heads/claude-code\n')
        if flags.get('worktree'): output('worktree /fixture-extra\nHEAD '+'a'*40+'\n')
    elif args[0]=='symbolic-ref': output('main' if flags.get('branch') else 'claude-code')
    elif args[0]=='status': output(' M fixture' if flags.get('dirty') else '')
    elif args[0]=='ls-files':
        if '--ignored' in args and flags.get('ignored_collision'): sys.stdout.write('cache/file\0')
    elif args[:2]==['config','--get-all']:
        output('https://fixture-token@github.com/example/fixture.git' if flags.get('token_url') else 'https://github.com/example/fixture.git')
    elif args[:2]==['config','--get-regexp']:
        if flags.get('url_rewrite'): output('url.fixture.insteadof https://github.com/'); stop(0)
        stop(1)
    elif args[0]=='fetch':
        (root/'FETCHED').write_text('fixture')
        if flags.get('fetch_hold'):
            deadline=time.monotonic()+20
            while not (root/'RELEASE').exists() and time.monotonic()<deadline: time.sleep(.05)
            if not (root/'RELEASE').exists(): stop(9)
        if flags.get('fetch_fail'): stop(7)
    elif args[0]=='rev-parse': output('b'*40)
    elif args[0]=='merge-base': stop(1 if flags.get('diverged') else 0)
    elif args[0]=='ls-tree': output('.env' if flags.get('tracked_env') else '')
    elif args[0]=='diff':
        if flags.get('ignored_collision'): sys.stdout.write('cache/file\0')
    elif args[0]=='merge':
        (root/'UPDATED').write_text('fixture')
        if flags.get('mutate_env'): (root/'.env').write_text((root/'.env').read_text()+'# mutation\n')
    else: raise RuntimeError('unexpected git command '+repr(args))
elif cmd=='docker':
    if args[0]=='ps':
        if flags.get('daemon_down'): stop(8)
        for c in containers(): output(c['Id'])
    elif args[0]=='inspect': output(json.dumps(containers()))
    elif args[0]=='compose':
        if 'config' in args: output(json.dumps(config()))
        elif 'up' in args:
            if flags.get('up_fail'): stop(6)
            (root/'STARTED').write_text('fixture')
        else: raise RuntimeError('unexpected compose command')
    elif args[0]=='exec':
        if 'mongosh' in args[-1]: stop(3 if flags.get('clients') else 0)
        elif 'mongodump' in args[-1]:
            content=b'not an archive' if flags.get('bad_archive') else b'\x6d\xe2\x99\x81synthetic archive payload'
            data=gzip.compress(content)
            if flags.get('truncated_archive'): data=data[:-5]
            sys.stdout.buffer.write(data)
            if flags.get('dump_fail'): stop(4)
        else: raise RuntimeError('unexpected docker exec')
    else: raise RuntimeError('unexpected docker command')
elif cmd=='mountpoint': stop(1 if flags.get('unmounted') else 0)
elif cmd=='du':
    if flags.get('du_fail'): stop(1)
    output('20\tfixture')
elif cmd=='df':
    if flags.get('df_fail'): stop(1)
    free=10 if flags.get('no_space') else 99999999
    output('Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 999999999 0 '+str(free)+' 1% /fixture')
elif cmd=='stat':
    path=pathlib.Path(args[-1])
    if args[1]=='%u': output('1' if flags.get('wrong_owner') else os.environ['DC_OWNER'])
    elif args[1]=='%a': output('644' if path.name=='.env' and flags.get('env_public') else ('600' if path.name=='.env' else '755'))
    else: raise RuntimeError('unexpected stat')
elif cmd=='curl':
    output(json.dumps({'status':'wrong' if flags.get('bad_health') else 'ok','app':'drive_connector','database':'ok','worker':'ok'}))
else: raise RuntimeError('unstubbed command '+cmd)
'''


class DeploymentFixtureIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='dc-deploy-fixture-')
        self.addCleanup(self.tmp.cleanup)
        self.area = Path(self.tmp.name)
        self.root = self.area / 'checkout'
        self.root.mkdir()
        (self.root / '.git').mkdir()
        (self.root / 'scripts').mkdir()
        self.storage = self.area / 'storage'
        self.storage.mkdir()
        (self.storage / 'mongodb').mkdir()
        (self.storage / 'mongodb' / 'fixture-data').write_bytes(b'synthetic, not database data')
        self.backups = self.area / 'backups'
        self.backups.mkdir()
        self.tools = self.area / 'tools'
        self.tools.mkdir()
        for name in ('setup.sh', 'update.sh', 'scripts/deploy_claude.sh', 'scripts/prepare_environment.py'):
            shutil.copyfile(ROOT / name, self.root / name)
        template = (ROOT / '.env.example').read_text().replace('/mnt/storage', self.storage.as_posix())
        (self.root / '.env.example').write_text(template)
        (self.root / 'docker-compose.yml').write_text('services: {}\n# ${STORAGE_DIR} ${JWT_SECRET_KEY}\n')
        initialized = subprocess.run([sys.executable, '-I', str(self.root / 'scripts/prepare_environment.py'),
                                      'init', str(self.root / '.env'), '--template', str(self.root / '.env.example')],
                                     capture_output=True, text=True)
        self.assertEqual(initialized.returncode, 0, initialized.stderr)
        self.original = (self.root / '.env').read_bytes()
        self.bash = shutil.which('bash')
        if not self.bash:
            self.skipTest('bash is required for the stubbed shell integration tests')
        # Python on Windows uses ';' for PATH, but the shell consumes ':'. Resolve
        # to POSIX before launching so no real system command wins over a stub.
        def shell_path(path):
            value = path.as_posix()
            if os.name == 'nt':
                return '/' + value[0].lower() + value[2:]
            return value
        self.shell_root = shell_path(self.root)
        self.shell_backup = shell_path(self.backups)
        owner = subprocess.check_output([self.bash, '-c', 'printf %s "$EUID"'], text=True)
        if owner == '0':
            self.skipTest('helper intentionally refuses root; run fixture tests as an ordinary user')
        self.env = {k:v for k,v in os.environ.items()
                    if not k.startswith(('GIT_', 'DOCKER_', 'COMPOSE_'))
                    and k not in CHECKS.entries(template)}
        self.env.update(DC_FIXTURE=str(self.root), DC_OWNER=owner, PYTHONDONTWRITEBYTECODE='1')
        # Start Bash with an explicit POSIX PATH; do not depend on Windows PATH conversion.
        self.prefix = 'export PATH="' + shell_path(self.tools) + ':/usr/bin:/bin"; '
        driver = self.tools / 'fixture_driver.py'
        driver.write_text(FIXTURE_DRIVER)
        launcher = self.tools / 'python_launcher.py'
        shutil.copyfile(ROOT / 'tests/deployment_fixture_launcher.py', launcher)
        self.env['DC_DRIVER_SCRIPT'] = str(driver)
        executable = sys.executable.replace('\\', '/')
        for command in ('git', 'docker', 'mountpoint', 'du', 'df', 'stat', 'curl'):
            tool = self.tools / command
            tool.write_text('#!/usr/bin/env bash\nexec "' + executable + '" -I "' + driver.as_posix() + '" ' + command + ' "$@"\n')
            tool.chmod(0o755)
        for command, text in {
            'python3': 'exec "' + executable + '" -I "' + launcher.as_posix() + '" "$@"',
            'sleep': 'exit 0',
            'timeout': 'shift; exec "$@"',
        }.items():
            tool = self.tools / command
            tool.write_text('#!/usr/bin/env bash\n' + text + '\n')
            tool.chmod(0o755)
        self.flags()

    def flags(self, **values):
        (self.root / 'flags.json').write_text(json.dumps(values))

    def deploy(self, *args, entry='update.sh', background=False):
        command = self.prefix + 'exec bash "$1" "$2" "${@:3}"'
        invocation = [self.bash, '-c', command, 'fixture', self.shell_root + '/' + entry,
                      self.shell_backup, *args]
        if background:
            return subprocess.Popen(invocation, env=self.env, cwd=self.area,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        return subprocess.run(invocation, env=self.env, cwd=self.area,
                              capture_output=True, text=True, timeout=90)

    def events(self):
        log = self.root / 'events.jsonl'
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def assert_no_update(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / 'UPDATED').exists())
        self.assertFalse((self.root / 'STARTED').exists())
        self.assertEqual((self.root / '.env').read_bytes(), self.original)
        self.assertFalse((self.root / '.git/driveconnector-deploy.lock').exists())

    def test_existing_update_backs_up_before_fetch_and_keeps_credentials(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual((self.root / '.env').read_bytes(), self.original)
        saved = list(self.backups.glob('*/.env'))
        self.assertEqual(len(saved), 1)
        self.assertEqual(saved[0].read_bytes(), self.original)
        archive = saved[0].parent / 'mongodb.archive.gz'
        self.assertTrue(gzip.decompress(archive.read_bytes()).startswith(b'\x6d\xe2\x99\x81'))
        events = self.events()
        dump = next(i for i, (cmd, args) in enumerate(events) if cmd == 'docker' and args[0] == 'exec' and 'mongodump' in args[-1])
        fetch = next(i for i, (cmd, args) in enumerate(events) if cmd == 'git' and 'fetch' in args)
        merge = next(i for i, (cmd, args) in enumerate(events) if cmd == 'git' and 'merge' in args)
        up = next(i for i, (cmd, args) in enumerate(events) if cmd == 'docker' and 'up' in args)
        self.assertLess(dump, fetch)
        self.assertLess(fetch, merge)
        self.assertLess(merge, up)
        fetch_args = events[fetch][1]
        self.assertIn('credential.helper=', fetch_args)
        self.assertIn('https://github.com/example/fixture.git', fetch_args)
        self.assertNotIn('origin', fetch_args)
        self.assertFalse((self.root / '.git/driveconnector-deploy.lock').exists())
        for line in self.original.decode().splitlines():
            if line.startswith(tuple(k + '=' for k in CHECKS.SECRET_KEYS)):
                self.assertNotIn(line.split('=', 1)[1], json.dumps(events))

    def test_fresh_start_can_retry_without_regenerating_any_secrets(self):
        (self.root / '.env').unlink()
        (self.storage / 'mongodb/fixture-data').unlink()
        self.flags(existing=False, up_fail=True)
        first = self.deploy('--init', entry='setup.sh')
        self.assertNotEqual(first.returncode, 0, first.stdout + first.stderr)
        generated = (self.root / '.env').read_bytes()
        self.assertNotEqual(generated, self.original)
        self.assertFalse((self.root / 'STARTED').exists())
        self.flags(existing=False)
        second = self.deploy('--init', entry='setup.sh')
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual((self.root / '.env').read_bytes(), generated)
        self.assertEqual(len(list(self.backups.glob('*/.env'))), 2)
        self.assertFalse(any(cmd == 'docker' and 'mongodump' in args[-1]
                             for cmd, args in self.events() if args))

    def test_fail_closed_preflight_and_backup_boundaries(self):
        cases = ('dirty', 'branch', 'worktree', 'wrong_owner', 'env_public', 'daemon_down',
                 'unmounted', 'mount_mismatch', 'credentials_mismatch', 'foreign_project',
                 'concurrent_container', 'clients', 'du_fail', 'df_fail', 'no_space',
                 'dump_fail', 'bad_archive', 'truncated_archive', 'stopped', 'ambient_config')
        for case in cases:
            with self.subTest(case=case):
                self.flags(**{case: True})
                self.assert_no_update(self.deploy())
                self.assertFalse((self.root / 'FETCHED').exists())

    def test_fetch_rejects_credential_urls_and_git_rewrites_without_leaking_token(self):
        for case in ('token_url', 'url_rewrite'):
            with self.subTest(case=case):
                self.flags(**{case: True})
                result = self.deploy()
                self.assert_no_update(result)
                self.assertFalse((self.root / 'FETCHED').exists())
                self.assertNotIn('fixture-token', result.stdout + result.stderr)

    def test_fetch_failure_divergence_and_ignored_collisions_do_not_merge(self):
        for case in ('fetch_fail', 'diverged', 'ignored_collision', 'tracked_env'):
            with self.subTest(case=case):
                self.flags(**{case: True})
                self.assert_no_update(self.deploy())

    def test_old_default_secret_is_rejected_not_replaced(self):
        content = self.original.decode()
        key = 'MONGO_INITDB_ROOT_PASSWORD='
        value = next(line.split('=', 1)[1] for line in content.splitlines() if line.startswith(key))
        self.original = content.replace(key + value, key + 'secretpassword').encode()
        (self.root / '.env').write_bytes(self.original)
        self.assert_no_update(self.deploy())
        self.assertFalse((self.root / 'FETCHED').exists())

    def test_missing_backup_directory_never_initializes(self):
        (self.root / '.env').unlink()
        self.backups.rmdir()
        self.flags(existing=False)
        result = self.deploy('--init')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / '.env').exists())
        self.assertFalse((self.root / 'FETCHED').exists())

    def test_fresh_init_refuses_existing_data_and_daemon_failure(self):
        (self.root / '.env').unlink()
        self.flags(existing=False)
        result = self.deploy('--init')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / '.env').exists())
        (self.storage / 'mongodb/fixture-data').unlink()
        self.flags(existing=False, daemon_down=True)
        result = self.deploy('--init')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / '.env').exists())

    def test_env_and_compose_rechecked_after_fast_forward(self):
        for case in ('updated_config_bad', 'mutate_env'):
            with self.subTest(case=case):
                (self.root / '.env').write_bytes(self.original)
                self.flags(**{case: True})
                result = self.deploy()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertTrue((self.root / 'UPDATED').exists())
                self.assertFalse((self.root / 'STARTED').exists())
                self.assertTrue(any(p.read_bytes() == self.original for p in self.backups.glob('*/.env')))
                if case == 'updated_config_bad':
                    self.assertEqual((self.root / '.env').read_bytes(), self.original)

    def test_unhealthy_app_container_cannot_be_masked_by_old_http_health(self):
        self.flags(unhealthy=True)
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('readiness', result.stderr)
        self.assertTrue((self.root / 'STARTED').exists())
        self.assertFalse((self.root / '.git/driveconnector-deploy.lock').exists())

    def test_existing_lock_is_not_removed_or_bypassed(self):
        lock = self.root / '.git/driveconnector-deploy.lock'
        lock.mkdir()
        (lock / 'sentinel').write_text('other deployment')
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((lock / 'sentinel').read_text(), 'other deployment')
        self.assertFalse([event for event in self.events() if event[0] != 'stat'])

    def test_two_deployments_cannot_run_concurrently(self):
        self.flags(fetch_hold=True)
        first = self.deploy(background=True)
        try:
            deadline = time.monotonic() + 25
            while not (self.root / 'FETCHED').exists() and time.monotonic() < deadline and first.poll() is None:
                time.sleep(.05)
            self.assertTrue((self.root / 'FETCHED').exists())
            second = self.deploy()
            self.assertNotEqual(second.returncode, 0)
            self.assertIn('lock', second.stderr.lower())
            self.assertTrue((self.root / '.git/driveconnector-deploy.lock').is_dir())
        finally:
            (self.root / 'RELEASE').write_text('fixture release')
            out, err = first.communicate(timeout=60)
        self.assertEqual(first.returncode, 0, out + err)
        self.assertEqual(len(list(self.backups.glob('*/.env'))), 1)
        self.assertFalse((self.root / '.git/driveconnector-deploy.lock').exists())

    def test_file_style_worktree_is_refused(self):
        (self.root / '.git').rmdir()
        (self.root / '.git').write_text('gitdir: /not-a-real-worktree\n')
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse([event for event in self.events() if event[0] != 'stat'])


# The original environment tests above are retained unchanged. The tests below
# execute only copied helpers, with synthetic files and PATH-intercepted commands.
import importlib.util
import json
import time
from unittest.mock import patch


def helper_module():
    spec = importlib.util.spec_from_file_location('deployment_fixture_helper', ROOT / 'scripts' / 'prepare_environment.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class DeploymentSafetyUnitTests(DeploymentEnvironmentTests):
    def test_listing_permission_error_is_not_empty(self):
        module = helper_module()
        (self.root / 'mongodb').mkdir()
        with patch.object(module.os, 'scandir', side_effect=PermissionError('synthetic denied listing')):
            with self.assertRaises(PermissionError):
                module.empty_database(self.root)

    def test_listing_error_is_not_empty(self):
        module = helper_module()
        (self.root / 'mongodb').mkdir()
        with patch.object(module.os, 'scandir', side_effect=OSError('synthetic IO error')):
            with self.assertRaises(OSError):
                module.empty_database(self.root)

    def test_invalid_init_never_creates_env(self):
        self.template.write_text(self.template.read_text().replace('MONGO_INITDB_DATABASE=media_db',
                                                                 'MONGO_INITDB_DATABASE=bad/value'))
        self.assertNotEqual(self.run_helper('init', self.envfile, '--template', self.template).returncode, 0)
        self.assertFalse(self.envfile.exists())

    def test_storage_must_exist(self):
        self.template.write_text(self.template.read_text().replace(self.root.as_posix(), (self.root / 'missing').as_posix()))
        self.assertNotEqual(self.run_helper('init', self.envfile, '--template', self.template).returncode, 0)
        self.assertFalse(self.envfile.exists())

    def test_backup_preserves_bytes_and_metadata(self):
        module = helper_module()
        self.assertEqual(self.run_helper('init', self.envfile, '--template', self.template).returncode, 0)
        self.envfile.write_bytes(self.envfile.read_bytes().replace(b'\n', b'\r\n'))
        before = self.envfile.stat()
        saved = self.root / 'backup'
        saved.mkdir()
        module.backup_environment(self.envfile, saved)
        self.assertEqual(self.envfile.read_bytes(), (saved / '.env').read_bytes())
        after = self.envfile.stat()
        self.assertEqual((before.st_uid, before.st_gid, before.st_mode, before.st_ino, before.st_mtime_ns),
                         (after.st_uid, after.st_gid, after.st_mode, after.st_ino, after.st_mtime_ns))
        module.unchanged(self.envfile, saved)
        self.envfile.write_bytes(self.envfile.read_bytes() + b'\n')
        with self.assertRaises(ValueError):
            module.unchanged(self.envfile, saved)

    def test_capacity_boundaries_and_invalid_measurements(self):
        module = helper_module()
        module.space('100', '102601', '102401')
        for args in [('100', '102600', '102401'), ('1', '10000000', '102400'),
                     ('', '10000000', '10000000'), ('-1', '10000000', '10000000')]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                module.space(*args)

    def test_control_keys_and_shell_syntax_rejected(self):
        module = helper_module()
        for text in ['COMPOSE_FILE=evil\n', 'DOCKER_HOST=elsewhere\n', 'GIT_DIR=elsewhere\n',
                     'A=`command`\n', 'A=$(command)\n']:
            with self.subTest(text=text), self.assertRaises(ValueError):
                module.entries(text)


# This driver lives beside (not inside) the synthetic checkout. Every external
# Git/Docker/mount/space/network operation in the integration cases hits it.
DRIVER = r'''
import gzip
import json
import os
from pathlib import Path
import sys
import time

sys.stdout.reconfigure(newline='\n')
base = Path(os.environ['DC_FIXTURE'])
root = base / 'checkout'
flags = json.loads((base / 'flags.json').read_text())
cmd, args = sys.argv[1], sys.argv[2:]
with (base / 'events.jsonl').open('a') as f:
    f.write(json.dumps([cmd, args]) + '\n')

def done(value='', code=0):
    if value:
        print(value)
    sys.exit(code)

def values():
    return dict(line.split('=', 1) for line in (root / '.env').read_text().splitlines()
                if line and not line.startswith('#'))

names = {'mongodb': 'media_mongodb', 'backend': 'media_backend', 'media-worker': 'media_worker',
         'mongo-express': 'media_mongo_express', 'jdownloader': 'media_jdownloader', 'nginx': 'media_nginx'}

def configuration():
    env = values()
    url = 'mongodb://{MONGO_INITDB_ROOT_USERNAME}:{MONGO_INITDB_ROOT_PASSWORD}@mongodb:27017/{MONGO_INITDB_DATABASE}?authSource=admin'.format(**env)
    services = {s: {'container_name': n} for s, n in names.items()}
    services['mongodb'].update(image='mongo:7.0', environment={k: env[k] for k in
            ('MONGO_INITDB_ROOT_USERNAME', 'MONGO_INITDB_ROOT_PASSWORD', 'MONGO_INITDB_DATABASE')},
            volumes=[{'target': '/data/db', 'type': 'bind', 'source': str(base / 'storage' / 'mongodb')}])
    for s in ('backend', 'media-worker'):
        services[s]['environment'] = {'MONGODB_URL': url, 'DATABASE_NAME': env['MONGO_INITDB_DATABASE'],
                                      **{key: env[key] for key in ('JWT_SECRET_KEY', 'ADMIN_USERNAME', 'ADMIN_DEFAULT_PASSWORD', 'STORAGE_DIR')}}
    if flags.get('updated_mount') and (base / 'updated').exists():
        services['mongodb']['volumes'][0]['source'] = str(base / 'wrong')
    if flags.get('compose_credentials'):
        services['mongodb']['environment']['MONGO_INITDB_ROOT_PASSWORD'] = 'not-the-original'
    return {'name': 'driveconnector', 'services': services}

def containers():
    started = (base / 'started').exists()
    services = list(names) if started else ([] if flags.get('fresh') else ['mongodb'])
    result = []
    for s in services:
        env = values() if (root / '.env').exists() else {}
        result.append({'Id': ('%064x' % (list(names).index(s) + 1)), 'Name': '/' + names[s],
            'State': {'Running': not flags.get('stopped'), 'Health': {'Status': 'healthy'}},
            'Config': {'Image': 'mongo:7.0' if s == 'mongodb' else 'fixture',
                'Env': [k + '=' + v for k, v in env.items()],
                'Labels': {'com.docker.compose.project': 'driveconnector',
                    'com.docker.compose.service': s,
                    'com.docker.compose.project.working_dir': str(root)}},
            'Mounts': ([{'Destination': '/data/db', 'Type': 'bind', 'Source': str(base / 'storage' / 'mongodb')}] if s == 'mongodb' else []),
            'NetworkSettings': {'Networks': {'fixture-net': {}}}})
    if result and flags.get('foreign_project'):
        result[0]['Config']['Labels']['com.docker.compose.project'] = 'another-project'
    if result and flags.get('wrong_credentials'):
        result[0]['Config']['Env'] = ['MONGO_INITDB_ROOT_PASSWORD=different']
    if flags.get('concurrent_container'):
        result.append({'Id': 'f' * 64, 'Name': '/unrelated-database', 'State': {'Running': True},
                       'Mounts': [{'Type': 'bind', 'Source': str(base / 'storage' / 'mongodb')} ]})
    if started and flags.get('worker_unhealthy'):
        next(c for c in result if c['Name'] == '/media_worker')['State']['Health']['Status'] = 'unhealthy'
    return result

if cmd == 'git':
    while args[:1] == ['-c']:
        args = args[2:]
    if args == ['rev-parse', '--show-toplevel']: done(str(root))
    if args == ['rev-parse', '--git-common-dir']: done('.git')
    if args == ['worktree', 'list', '--porcelain']:
        done('worktree ' + str(root) + '\n' + ('worktree another\n' if flags.get('worktrees') else ''))
    if args[:1] == ['symbolic-ref']: done('main' if flags.get('wrong_branch') else 'claude-code')
    if args[:1] == ['status']: done(' M file' if flags.get('dirty') else '')
    if args[:2] == ['config', '--get-all']:
        done('https://synthetic-token@github.com/example/project.git' if flags.get('token_url') else 'https://github.com/example/project.git')
    if args[:2] == ['config', '--get-regexp']: done('url.fake.insteadof synthetic' if flags.get('rewrite') else '', 0 if flags.get('rewrite') else 1)
    if args[:1] == ['fetch']:
        (base / 'fetching').touch()
        if flags.get('hold_fetch'):
            limit = time.monotonic() + 30
            while not (base / 'release').exists() and time.monotonic() < limit: time.sleep(.025)
        done(code=1 if flags.get('fetch_fail') else 0)
    if args == ['rev-parse', 'refs/remotes/origin/claude-code']: done('a' * 40)
    if args[:1] == ['merge-base']: done(code=1 if flags.get('diverged') else 0)
    if args[:1] == ['ls-tree']: done('.env' if flags.get('incoming_env') else '')
    if args[:1] == ['diff']: done('ignored\x00' if flags.get('ignored_collision') else '')
    if args[:1] == ['ls-files']: done('ignored\x00' if '--ignored' in args and flags.get('ignored_collision') else '')
    if args[:1] == ['merge']:
        (base / 'updated').touch()
        if flags.get('env_change'):
            with (root / '.env').open('ab') as f: f.write(b'\n')
        done()
    done('unhandled fixture git command', 99)
if cmd == 'docker':
    if args[:1] == ['ps']:
        if flags.get('daemon_error'): done('synthetic daemon unavailable', 1)
        done('\n'.join(c['Id'] for c in containers()))
    if args[:1] == ['inspect']: done(json.dumps(containers()))
    if args[:1] == ['compose']:
        if 'config' in args: done(json.dumps(configuration()))
        if 'up' in args:
            if flags.get('compose_fail'): done('synthetic startup failure', 1)
            (base / 'started').touch()
            done()
    if args[:1] == ['exec']:
        if 'mongosh' in args[-1]: done(code=1 if flags.get('clients') else 0)
        if 'mongodump' in args[-1]:
            payload = gzip.compress(b'\x6d\xe2\x99\x81synthetic-archive')
            if flags.get('bad_archive'): payload = gzip.compress(b'not-an-archive')
            if flags.get('truncated_archive'): payload = payload[:-4]
            sys.stdout.buffer.write(payload)
            sys.exit(1 if flags.get('dump_fail') else 0)
    done('unhandled fixture docker command', 99)
if cmd == 'mountpoint': done(code=1 if flags.get('missing_mount') else 0)
if cmd == 'du':
    if flags.get('du_error'): done('synthetic listing failed', 1)
    done('100\t' + str(base / 'storage' / 'mongodb'))
if cmd == 'df':
    free = 1 if flags.get('no_space') else 10000000
    done('Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 20000000 100 ' + str(free) + ' 1% /fixture')
if cmd == 'curl':
    if flags.get('api_bad'): done(json.dumps({'status': 'not-ready', 'app': 'drive_connector'}))
    done(json.dumps({'status': 'ok', 'app': 'drive_connector', 'database': 'ok', 'worker': 'ok'}))
if cmd == 'stat':
    if args[1] == '%u': done('0' if flags.get('wrong_owner') else os.environ['DC_EUID'])
    if args[1] == '%a': done('777' if flags.get('writable_checkout') else '600' if args[-1] == '.env' else '755')
    done('unhandled fixture stat', 99)
done('unhandled fixture command', 99)
'''


@unittest.skipUnless(shutil.which('bash'), 'Bash is required for stubbed integration tests')
class DeploymentIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='deployment-synthetic-')
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root = self.base / 'checkout'
        self.root.mkdir()
        (self.root / '.git').mkdir()
        (self.root / 'scripts').mkdir()
        self.backup = self.base / 'backups'
        self.backup.mkdir()
        self.storage = self.base / 'storage'
        self.storage.mkdir()
        (self.storage / 'mongodb').mkdir()
        (self.storage / 'mongodb' / 'fixture-data').write_bytes(b'synthetic')
        for name in ('deploy_claude.sh', 'prepare_environment.py'):
            shutil.copyfile(ROOT / 'scripts' / name, self.root / 'scripts' / name)
        for name in ('setup.sh', 'update.sh'):
            shutil.copyfile(ROOT / name, self.root / name)
        template = (ROOT / '.env.example').read_text().replace('/mnt/storage', self.storage.as_posix())
        (self.root / '.env.example').write_text(template)
        # Contains interpolation for the ambient-variable check, but no real config.
        (self.root / 'docker-compose.yml').write_text('fixture: ${JWT_SECRET_KEY}\n')
        result = subprocess.run([sys.executable, '-I', str(self.root / 'scripts' / 'prepare_environment.py'),
                                 'init', str(self.root / '.env'), '--template', str(self.root / '.env.example')],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.envbytes = (self.root / '.env').read_bytes()
        self.tools = self.base / 'tools'
        self.tools.mkdir()
        (self.base / 'driver.py').write_text(DRIVER)
        self.flags = {}
        self.set_flags()
        self.bash = shutil.which('bash')
        uid = subprocess.check_output([self.bash, '-c', 'printf "%s" "$EUID"'], text=True)
        if uid == '0':
            self.skipTest('owner-run entrypoint deliberately refuses root; run integration tests as an ordinary user')
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(('GIT_', 'DOCKER_', 'COMPOSE_')) and k not in helper_module().REQUIRED}
        self.env.update(DC_FIXTURE=str(self.base), DC_EUID=uid)
        # The shell performs native path conversion for the Windows interpreter.
        import shlex
        for cmd in ('git', 'docker', 'mountpoint', 'du', 'df', 'stat', 'curl'):
            wrapper = '#!/usr/bin/env bash\nexec ' + shlex.quote(sys.executable.replace('\\', '/')) + ' -I ' + shlex.quote((self.base / 'driver.py').as_posix()) + ' ' + cmd + ' "$@"\n'
            path = self.tools / cmd
            path.write_text(wrapper, newline='\n')
            path.chmod(0o700)
        launcher = self.tools / 'python_launcher.py'
        shutil.copyfile(ROOT / 'tests/deployment_fixture_launcher.py', launcher)
        self.env['DC_DRIVER_SCRIPT'] = str(self.base / 'driver.py')
        python = self.tools / 'python3'
        python.write_text('#!/usr/bin/env bash\nexec ' + shlex.quote(sys.executable.replace('\\', '/')) + ' -I ' + shlex.quote(launcher.as_posix()) + ' "$@"\n', newline='\n')
        python.chmod(0o700)
        # Keep tests quick; execution deadlines are asserted as argv, not timed here.
        for cmd, text in [('sleep', 'exit 0'), ('timeout', 'shift\nexec "$@"')]:
            p = self.tools / cmd
            p.write_text('#!/usr/bin/env bash\n' + text + '\n', newline='\n')
            p.chmod(0o700)
        toolpath = self.shellpath(self.tools)
        self.env['PATH'] = str(self.tools) + os.pathsep + self.env['PATH']
        self.shell_env_path = toolpath

    def shellpath(self, path):
        if os.name == 'nt':
            return subprocess.check_output([self.bash, '-c', 'cygpath -u "$1"', 'fixture', str(path)], text=True).strip()
        return str(path)

    def set_flags(self, **flags):
        self.flags = flags
        (self.base / 'flags.json').write_text(json.dumps(flags))

    def command(self, init=False):
        return [self.bash, '-c', 'export PATH="$1:$PATH"; shift; exec bash "$@"',
                'fixture', self.shell_env_path, self.shellpath(self.root / 'update.sh'),
                self.shellpath(self.backup), *(['--init'] if init else [])]

    def run_deploy(self, init=False):
        return subprocess.run(self.command(init), env=self.env, cwd=self.base,
                              capture_output=True, text=True, timeout=90)

    def events(self):
        path = self.base / 'events.jsonl'
        return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []

    def assert_no_update(self):
        self.assertFalse((self.base / 'updated').exists())
        self.assertFalse((self.base / 'started').exists())

    def test_existing_update_backups_and_order(self):
        result = self.run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / '.env').read_bytes(), self.envbytes)
        runs = list(self.backup.iterdir())
        self.assertEqual(len(runs), 1)
        self.assertEqual((runs[0] / '.env').read_bytes(), self.envbytes)
        self.assertTrue((runs[0] / 'mongodb.archive.gz').stat().st_size > 0)
        self.assertFalse((self.root / '.git' / 'driveconnector-deploy.lock').exists())
        events = self.events()
        dump = next(i for i, e in enumerate(events) if e[0] == 'docker' and 'mongodump' in e[1][-1])
        fetch = next(i for i, e in enumerate(events) if e[0] == 'git' and 'fetch' in e[1])
        merge = next(i for i, e in enumerate(events) if e[0] == 'git' and 'merge' in e[1])
        up = next(i for i, e in enumerate(events) if e[0] == 'docker' and 'up' in e[1])
        self.assertLess(dump, fetch)
        self.assertLess(fetch, merge)
        self.assertLess(merge, up)
        self.assertTrue(any(e[0] == 'curl' and 'http://127.0.0.1/api/ready' in e[1] for e in events))
        flattened = json.dumps(events)
        for line in self.envbytes.decode().splitlines():
            if line.startswith('MONGO_INITDB_ROOT_PASSWORD='):
                self.assertNotIn(line.split('=', 1)[1], flattened)
        for forbidden in ('--force', 'reset', 'stash', 'prune', 'chown', 'remote set-url'):
            self.assertNotIn(forbidden, flattened)

    def test_fresh_failure_can_retry_without_rotating_secrets(self):
        (self.root / '.env').unlink()
        (self.storage / 'mongodb' / 'fixture-data').unlink()
        self.set_flags(fresh=True, compose_fail=True)
        failed = self.run_deploy(init=True)
        self.assertNotEqual(failed.returncode, 0)
        generated = (self.root / '.env').read_bytes()
        self.assertTrue(generated)
        self.set_flags(fresh=True)
        result = self.run_deploy(init=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / '.env').read_bytes(), generated)
        self.assertEqual(len(list(self.backup.iterdir())), 2)
        self.assertFalse(any(e[0] == 'docker' and 'mongodump' in e[1][-1] for e in self.events()))

    def test_preflight_failures_never_update(self):
        for flag in ('dirty', 'worktrees', 'wrong_branch', 'wrong_owner', 'writable_checkout',
                     'missing_mount', 'daemon_error', 'foreign_project', 'wrong_credentials',
                     'stopped', 'concurrent_container', 'compose_credentials', 'du_error', 'no_space', 'clients'):
            with self.subTest(flag=flag):
                self.set_flags(**{flag: True})
                result = self.run_deploy()
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assert_no_update()
                self.assertEqual((self.root / '.env').read_bytes(), self.envbytes)
                self.assertFalse((self.root / '.git' / 'driveconnector-deploy.lock').exists())

    def test_failed_or_invalid_dump_never_fetches(self):
        for flag in ('dump_fail', 'bad_archive', 'truncated_archive'):
            with self.subTest(flag=flag):
                self.set_flags(**{flag: True})
                result = self.run_deploy()
                self.assertNotEqual(result.returncode, 0)
                self.assert_no_update()
                self.assertFalse((self.base / 'fetching').exists())
        self.assertEqual(len(list(self.backup.iterdir())), 3)
        self.assertTrue(all((p / '.env').read_bytes() == self.envbytes for p in self.backup.iterdir()))

    def test_remote_safety_failures_never_merge(self):
        for flag in ('token_url', 'rewrite', 'fetch_fail', 'diverged', 'incoming_env', 'ignored_collision'):
            with self.subTest(flag=flag):
                self.set_flags(**{flag: True})
                result = self.run_deploy()
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn('synthetic-token', result.stdout + result.stderr)
                self.assert_no_update()
                if flag in ('token_url', 'rewrite'):
                    self.assertFalse((self.base / 'fetching').exists())

    def test_new_compose_mount_blocks_startup_without_rollback(self):
        self.set_flags(updated_mount=True)
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.base / 'updated').exists())
        self.assertFalse((self.base / 'started').exists())
        self.assertEqual((self.root / '.env').read_bytes(), self.envbytes)
        self.assertTrue(any(self.backup.iterdir()))

    def test_env_change_after_merge_blocks_startup(self):
        self.set_flags(env_change=True)
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.base / 'updated').exists())
        self.assertFalse((self.base / 'started').exists())
        self.assertEqual(next(self.backup.iterdir()).joinpath('.env').read_bytes(), self.envbytes)

    def test_worker_health_is_required(self):
        self.set_flags(worker_unhealthy=True)
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('readiness', result.stderr)
        self.assertTrue((self.base / 'started').exists())

    def test_lock_blocks_concurrent_invocation_and_releases(self):
        self.set_flags(hold_fetch=True)
        first = subprocess.Popen(self.command(), env=self.env, cwd=self.base, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 30
            while not (self.base / 'fetching').exists() and first.poll() is None and time.monotonic() < deadline:
                time.sleep(.025)
            self.assertTrue((self.base / 'fetching').exists())
            second = self.run_deploy()
            self.assertNotEqual(second.returncode, 0)
            self.assertIn('lock', second.stderr)
            self.assertTrue((self.root / '.git' / 'driveconnector-deploy.lock').exists())
            (self.base / 'release').touch()
            stdout, stderr = first.communicate(timeout=60)
            self.assertEqual(first.returncode, 0, stdout + stderr)
            self.assertFalse((self.root / '.git' / 'driveconnector-deploy.lock').exists())
        finally:
            if first.poll() is None:
                first.kill()
                first.communicate()

    def test_missing_env_with_data_never_initializes(self):
        (self.root / '.env').unlink()
        self.set_flags(fresh=True)
        result = self.run_deploy(init=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.root / '.env').exists())
        self.assert_no_update()

    def test_git_file_rejected_before_any_git_operation(self):
        (self.root / '.git').rmdir()
        (self.root / '.git').write_text('gitdir: elsewhere\n')
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([event for event in self.events() if event[0] != 'stat'], [])

    def test_missing_backup_directory_never_updates(self):
        self.backup.rmdir()
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assert_no_update()

    def test_known_default_is_not_repaired(self):
        envfile = self.root / '.env'
        text = envfile.read_text()
        secret = next(line.split('=', 1)[1] for line in text.splitlines() if line.startswith('JWT_SECRET_KEY='))
        envfile.write_text(text.replace(secret, 'drive-connector-super-secret-key-2026-prod'))
        before = envfile.read_bytes()
        result = self.run_deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('unsafe legacy default', result.stderr)
        self.assertEqual(envfile.read_bytes(), before)
        self.assert_no_update()


if __name__ == '__main__':
    unittest.main()
