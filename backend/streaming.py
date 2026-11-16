"""Pure helpers for the authenticated HTTP byte-range streaming endpoints."""

import re
from typing import Optional, Tuple


class UnsatisfiableRange(ValueError):
    """The requested byte range cannot be represented for this resource."""


def select_byte_range(
    header: Optional[str], size: int, max_range: int
) -> Optional[Tuple[int, int]]:
    """Return an inclusive range, or None when no Range header was supplied.

    The server supports a single byte range only.  Open-ended and explicitly
    bounded requests are capped from the start; suffix requests are capped
    from the end so that the selected bytes always include the end of file.
    """
    if size < 0 or max_range <= 0:
        raise ValueError("Invalid stream size or range limit")
    if header is None:
        return None
    if len(header) > 128:
        raise UnsatisfiableRange("Invalid byte range")
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip(), re.IGNORECASE)
    if not match or size == 0:
        raise UnsatisfiableRange("Invalid or unsatisfiable byte range")
    first, last = match.groups()
    if not first and not last:
        raise UnsatisfiableRange("Invalid byte range")
    if not first:
        suffix = int(last)
        if suffix <= 0:
            raise UnsatisfiableRange("Invalid suffix byte range")
        return max(0, size - min(suffix, max_range)), size - 1
    start = int(first)
    if start >= size:
        raise UnsatisfiableRange("Range starts beyond the resource")
    end = min(int(last), size - 1) if last else size - 1
    if end < start:
        raise UnsatisfiableRange("Range end precedes start")
    return start, min(end, start + max_range - 1)
