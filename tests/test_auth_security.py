"""Authentication regressions using fake configuration and an in-memory stub."""

import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

# Load native extensions once before temporary sys.modules patches are applied.
import bcrypt  # noqa: F401
import jwt  # noqa: F401
from fastapi import HTTPException


class FakeCollection:
    def __init__(self, admin=None, any_user=None):
        self.admin = admin
        self.any_user = any_user
        self.inserted = []

    async def find_one(self, query):
        return self.admin if query else self.any_user

    async def insert_one(self, doc):
        self.inserted.append(doc)


class AuthenticationTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.settings = types.SimpleNamespace(
            ADMIN_USERNAME="fixture-user",
            ADMIN_DEFAULT_PASSWORD="fixture-not-used-unless-explicit",
            ACCESS_TOKEN_EXPIRE_MINUTES=30,
            JWT_SECRET_KEY="fixture-signing-key-that-is-not-a-real-secret",
            JWT_ALGORITHM="HS256",
            model_fields_set=set(),
        )
        self.db = {}
        config = types.ModuleType("config")
        config.settings = self.settings
        database = types.ModuleType("database")
        database.get_db = lambda: self.db
        path = Path(__file__).resolve().parents[1] / "backend" / "auth.py"
        spec = importlib.util.spec_from_file_location("auth_under_test", path)
        self.auth = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"config": config, "database": database}):
            spec.loader.exec_module(self.auth)

    async def test_database_failure_never_authenticates_fallback_user(self):
        self.auth.get_db = lambda: (_ for _ in ()).throw(RuntimeError("offline"))
        with self.assertRaises(HTTPException) as failure:
            await self.auth.get_user_by_username(self.settings.ADMIN_USERNAME)
        self.assertEqual(failure.exception.status_code, 503)

    async def test_existing_admin_is_not_modified(self):
        user = {"username": self.settings.ADMIN_USERNAME, "password_hash": "existing-hash"}
        users = FakeCollection(admin=user)
        self.db["users"] = users
        await self.auth.init_admin_user()
        self.assertEqual(users.inserted, [])
        self.assertEqual(user["password_hash"], "existing-hash")

    async def test_existing_other_users_do_not_cause_new_admin_creation(self):
        users = FakeCollection(any_user={"username": "existing-user"})
        self.db["users"] = users
        await self.auth.init_admin_user()
        self.assertEqual(users.inserted, [])

    async def test_fresh_database_requires_explicit_private_password(self):
        users = FakeCollection()
        self.db["users"] = users
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                await self.auth.init_admin_user()
        self.assertEqual(users.inserted, [])

    def test_malformed_stored_hash_does_not_raise(self):
        self.assertFalse(self.auth.verify_password("fixture-password", "invalid"))


if __name__ == "__main__":
    unittest.main()
