#!/usr/bin/env python3
"""Normalize heading levels in existing Paper Markdown attachments."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path


DEFAULT_STORAGE = Path("/Users/bytedance/Zotero/storage")


MAIN_SECTION_RE = re.compile(r"^([IVXLCDM]+)\.\s+\S", re.I)
NUMBERED_MAIN_RE = re.compile(r"^\d+[\.)]\s+\S")
NUMBERED_SUB_RE = re.compile(r"^(\d+(?:\.\d+)+)\.?\s+\S")
LETTER_SUB_RE = re.compile(r"^[A-Z]\.\s+\S")
SPECIAL_MAIN_RE = re.compile(
    r"^(?:abstract|references|bibliography|acknowledg(?:e)?ments?|appendix(?:\s+[A-Z0-9]+)?|keywords|index terms)$",
    re.I,
)
APPENDIX_MAIN_RE = re.compile(r"^appendix\s+[A-Z0-9]+[:.]?\s+\S", re.I)
HEADING_RE = re.compile(r"^(#{1,6})([ \t]+)(.+?)([ \t]*)$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--storage", type=Path, default=DEFAULT_STORAGE)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def is_main_section(text: str) -> bool:
    text = text.strip()
    roman = MAIN_SECTION_RE.match(text)
    return bool(
        (roman and roman.group(1).upper().startswith(("I", "V", "X")))
        or NUMBERED_MAIN_RE.match(text)
        or SPECIAL_MAIN_RE.match(text)
        or APPENDIX_MAIN_RE.match(text)
    )


def heading_level(text: str, saw_main_section: bool) -> int | None:
    if is_main_section(text):
        return 2
    numbered = NUMBERED_SUB_RE.match(text)
    if numbered:
        return min(6, len(numbered.group(1).split(".")) + 1)
    if saw_main_section and LETTER_SUB_RE.match(text):
        return 3
    return None


def normalize_text(text: str) -> tuple[str, list[dict]]:
    lines = text.split("\n")
    saw_document_title = False
    saw_main_section = False
    changes: list[dict] = []
    output: list[str] = []

    for line_number, line in enumerate(lines, start=1):
        match = HEADING_RE.match(line)
        if not match:
            output.append(line)
            continue

        current_level = len(match.group(1))
        title = match.group(3).strip()
        target_level = None

        if not saw_document_title and not is_main_section(title):
            target_level = 1
            saw_document_title = True
        else:
            target_level = heading_level(title, saw_main_section)
            if target_level is None and not saw_document_title:
                target_level = 1
                saw_document_title = True

        if target_level is None:
            output.append(line)
            continue

        if target_level == 2:
            saw_main_section = True

        if current_level != target_level:
            changes.append(
                {
                    "line": line_number,
                    "from": current_level,
                    "to": target_level,
                    "text": title,
                }
            )
        output.append("#" * target_level + match.group(2) + match.group(3) + match.group(4))

    return ("\n".join(output), changes)


def main() -> int:
    args = parse_args()
    directories = sorted(path.parent for path in args.storage.expanduser().glob("*/paper-markdown-meta.json"))
    entries = []
    for directory in directories:
        for md_path in sorted(directory.glob("*.md")):
            original = md_path.read_text(encoding="utf-8", errors="ignore")
            normalized, changes = normalize_text(original)
            if changes and args.apply:
                md_path.write_text(normalized, encoding="utf-8")
            if changes:
                entries.append(
                    {
                        "path": str(md_path),
                        "changes": changes,
                    }
                )

    totals = {
        "mode": "apply" if args.apply else "dry-run",
        "directories_seen": len(directories),
        "files_changed": len(entries),
        "headings_changed": sum(len(entry["changes"]) for entry in entries),
    }
    report = {"totals": totals, "entries": entries}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(totals, ensure_ascii=False, indent=2))
    if entries:
        print(json.dumps(entries[:5], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
