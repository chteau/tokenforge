import re


def slugify(text: str) -> str:
    """Lowercase, replace non-alphanumerics with '-', trim dashes."""
    s = re.sub(r"[^a-z0-9]", "-", text.lower())
    return s.strip("-")
