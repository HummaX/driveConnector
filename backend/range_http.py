"""Single-range parsing used by both audio and video endpoints.

Multiple ranges are intentionally ignored by the caller (a full 200 response),
which is allowed when multipart/byteranges is not supported.
"""
from dataclasses import dataclass
import re
from typing import Optional

@dataclass(frozen=True)
class ByteRange:
    start: int
    end: int

    @property
    def length(self) -> int:
        return self.end - self.start + 1

class RangeNotSatisfiable(ValueError):
    pass

class MultipleRanges(ValueError):
    pass

def parse_byte_range(header: str, file_size: int, open_ended_burst: Optional[int] = None) -> ByteRange:
    if not isinstance(header, str) or file_size < 0:
        raise RangeNotSatisfiable('Invalid range')
    value = header.strip()
    if ',' in value:
        raise MultipleRanges('Multipart ranges are not supported')
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', value, flags=re.IGNORECASE)
    if not match:
        raise RangeNotSatisfiable('Invalid range')
    first, last = match.groups()
    if file_size == 0 or (not first and not last):
        raise RangeNotSatisfiable('Empty range')
    if not first:
        suffix = file_size if len(last) > 20 else int(last)
        if suffix <= 0:
            raise RangeNotSatisfiable('Invalid suffix')
        return ByteRange(max(0, file_size - suffix), file_size - 1)
    if len(first) > 20:
        raise RangeNotSatisfiable('Range starts beyond end of file')
    start = int(first)
    if start >= file_size:
        raise RangeNotSatisfiable('Range starts beyond end of file')
    if last:
        end = file_size - 1 if len(last) > 20 else min(int(last), file_size - 1)
        if end < start:
            raise RangeNotSatisfiable('Reversed range')
        return ByteRange(start, end)
    end = file_size - 1
    if open_ended_burst and open_ended_burst > 0:
        end = min(end, start + open_ended_burst - 1)
    return ByteRange(start, end)
