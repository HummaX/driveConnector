"""In-memory Mongo boundary for isolated tests; not a MongoDB integration test."""
from copy import deepcopy
import threading
from types import SimpleNamespace
from pymongo.errors import DuplicateKeyError


def value_at(document, key):
    value = document
    for part in key.split('.'):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def matches(document, query):
    for key, expected in query.items():
        if key in ('$or', '$and'):
            values = [matches(document, item) for item in expected]
            if not (any(values) if key == '$or' else all(values)):
                return False
            continue
        if key == '$expr':
            for operation, operands in expected.items():
                left, right = [value_at(document, v[1:]) if isinstance(v, str) and v.startswith('$') else v for v in operands]
                if operation == '$lt' and not left < right:
                    return False
                if operation == '$gte' and not left >= right:
                    return False
                if operation not in ('$lt', '$gte'):
                    raise NotImplementedError(operation)
            continue
        value = value_at(document, key)
        if isinstance(expected, dict):
            for operation, operand in expected.items():
                if operation == '$in':
                    ok = value in operand
                elif operation == '$nin':
                    ok = value not in operand
                elif operation == '$ne':
                    ok = value != operand
                elif operation == '$exists':
                    ok = bool(operand) == (key in document)
                elif operation in ('$gt', '$gte', '$lt', '$lte'):
                    try:
                        ok = {'$gt': lambda: value > operand, '$gte': lambda: value >= operand,
                              '$lt': lambda: value < operand, '$lte': lambda: value <= operand}[operation]()
                    except TypeError:
                        ok = False
                else:
                    raise NotImplementedError(operation)
                if not ok:
                    return False
        elif value != expected:
            return False
    return True


def apply_update(document, update, inserting=False):
    pairs = dict(update.get('$setOnInsert', {})) if inserting else {}
    pairs.update(update.get('$set', {}))
    for key, value in pairs.items():
        node = document
        parts = key.split('.')
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = deepcopy(value)
    for key, value in update.get('$inc', {}).items():
        document[key] = document.get(key, 0) + value
    for key in update.get('$unset', {}):
        document.pop(key, None)


def project(document, projection):
    result = deepcopy(document)
    if projection:
        includes = [key for key, enabled in projection.items() if enabled and key != '_id']
        if includes:
            result = {key: result[key] for key in includes if key in result}
            if projection.get('_id', 1) and '_id' in document:
                result['_id'] = document['_id']
        else:
            for key, enabled in projection.items():
                if not enabled:
                    result.pop(key, None)
    return result


class MemoryCursor:
    def __init__(self, documents):
        self.documents = documents

    def sort(self, key, direction=None):
        for field, order in reversed(key if isinstance(key, list) else [(key, direction)]):
            self.documents.sort(key=lambda row: (value_at(row, field) is not None, value_at(row, field)), reverse=order < 0)
        return self

    def skip(self, amount):
        self.documents = self.documents[amount:]
        return self

    def limit(self, amount):
        self.documents = self.documents[:amount]
        return self

    async def to_list(self, length=None):
        return deepcopy(self.documents[:length])


class MemoryCollection:
    def __init__(self, name):
        self.name, self.documents, self.operations, self.indexes = name, {}, [], []
        self.lock = threading.RLock()

    def check_unique(self, candidate, current_id=None):
        for keys, partial in self.indexes:
            if not matches(candidate, partial):
                continue
            for key, existing in self.documents.items():
                if key != current_id and matches(existing, partial) and all(value_at(existing, f) == value_at(candidate, f) for f in keys):
                    raise DuplicateKeyError('synthetic unique index collision')

    async def find_one(self, query=None, projection=None):
        with self.lock:
            self.operations.append(('find_one', deepcopy(query)))
            return next((project(d, projection) for d in self.documents.values() if matches(d, query or {})), None)

    def find(self, query=None, projection=None):
        return MemoryCursor([project(d, projection) for d in self.documents.values() if matches(d, query or {})])

    async def distinct(self, key, query=None):
        return list({value_at(d, key) for d in self.documents.values() if matches(d, query or {})})

    async def replace_one(self, query, replacement, upsert=False):
        with self.lock:
            self.operations.append(('replace_one', deepcopy(query)))
            for key, document in self.documents.items():
                if matches(document, query):
                    result = deepcopy(replacement)
                    result.setdefault('_id', key)
                    self.check_unique(result, key)
                    self.documents[key] = result
                    return SimpleNamespace(modified_count=int(document != result), upserted_id=None)
            if upsert:
                result = deepcopy(replacement)
                key = result.setdefault('_id', query.get('_id', str(len(self.documents) + 1)))
                if key in self.documents:
                    raise DuplicateKeyError('synthetic duplicate _id')
                self.check_unique(result)
                self.documents[key] = result
                return SimpleNamespace(modified_count=0, upserted_id=key)
            return SimpleNamespace(modified_count=0, upserted_id=None)

    async def insert_one(self, document):
        result = await self.replace_one({'_id': document.get('_id', str(len(self.documents) + 1)), '__absent': True}, document, upsert=True)
        return SimpleNamespace(inserted_id=result.upserted_id)

    async def update_one(self, query, update, upsert=False):
        old = await self.find_one(query)
        result = await self.find_one_and_update(query, update, upsert=upsert, return_document=True)
        return SimpleNamespace(modified_count=int(old is not None and old != result), matched_count=int(old is not None),
                               upserted_id=result.get('_id') if old is None and result else None)

    async def update_many(self, query, update):
        with self.lock:
            modified = 0
            for document in self.documents.values():
                if matches(document, query):
                    candidate = deepcopy(document)
                    apply_update(candidate, update)
                    self.check_unique(candidate, document['_id'])
                    modified += int(candidate != document)
                    document.clear()
                    document.update(candidate)
            return SimpleNamespace(modified_count=modified)

    async def find_one_and_update(self, query, update, sort=None, return_document=None, upsert=False):
        with self.lock:
            rows = [document for document in self.documents.values() if matches(document, query)]
            for key, direction in reversed(sort or []):
                rows.sort(key=lambda row: (value_at(row, key) is not None, value_at(row, key)), reverse=direction < 0)
            for document in rows:
                if matches(document, query):
                    old = deepcopy(document)
                    candidate = deepcopy(document)
                    apply_update(candidate, update)
                    self.check_unique(candidate, document['_id'])
                    document.clear()
                    document.update(candidate)
                    return deepcopy(document) if return_document else old
            if upsert:
                candidate = {key: value for key, value in query.items() if not key.startswith('$') and not isinstance(value, dict)}
                candidate.setdefault('_id', str(len(self.documents) + 1))
                apply_update(candidate, update, inserting=True)
                if candidate['_id'] in self.documents:
                    raise DuplicateKeyError('synthetic duplicate _id')
                self.check_unique(candidate)
                self.documents[candidate['_id']] = candidate
                return deepcopy(candidate) if return_document else None
        return None

    async def count_documents(self, query, **kwargs):
        count = sum(matches(document, query) for document in self.documents.values())
        return min(count, kwargs['limit']) if kwargs.get('limit') else count

    async def create_index(self, keys, unique=False, partialFilterExpression=None, **kwargs):
        if unique:
            fields = (keys,) if isinstance(keys, str) else tuple(item[0] for item in keys)
            index = (fields, partialFilterExpression or {})
            if index not in self.indexes:
                self.indexes.append(index)
            for document in self.documents.values():
                self.check_unique(document, document['_id'])
        return kwargs.get('name', 'synthetic-index')


class MemoryDatabase:
    def __init__(self):
        self.collections = {}

    def __getitem__(self, name):
        if name not in self.collections:
            self.collections[name] = MemoryCollection(name)
        return self.collections[name]

    def report(self):
        return {name: {'documents': list(collection.documents.values()), 'operations': collection.operations}
                for name, collection in self.collections.items()}
