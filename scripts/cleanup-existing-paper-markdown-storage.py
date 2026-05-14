#!/usr/bin/env python3
"""Clean legacy Paper Markdown storage directories.

This only touches Zotero storage directories that contain
paper-markdown-meta.json, so unrelated Zotero attachments are left alone.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
from pathlib import Path
from urllib.parse import unquote


DEFAULT_STORAGE = Path("/Users/bytedance/Zotero/storage")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--storage", type=Path, default=DEFAULT_STORAGE)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--report", type=Path)
    return parser.parse_args()


def bytes_for_path(path: Path) -> int:
    if path.is_file() or path.is_symlink():
        try:
            return path.stat().st_size
        except OSError:
            return 0
    total = 0
    if path.is_dir():
        for child in path.rglob("*"):
            if child.is_file() or child.is_symlink():
                try:
                    total += child.stat().st_size
                except OSError:
                    pass
    return total


def rewrite_markdown_references(text: str) -> str:
    replacements = (
        (r"](\./images/", "](Attachments/"),
        (r"](images/", "](Attachments/"),
        ("src=\"./images/", "src=\"Attachments/"),
        ("src=\"images/", "src=\"Attachments/"),
        ("src='./images/", "src='Attachments/"),
        ("src='images/", "src='Attachments/"),
    )
    for old, new in replacements:
        text = text.replace(old, new)
    return text


def normalize_reference_target(target: str) -> str | None:
    target = target.strip()
    if not target:
        return None
    if target.startswith("<") and ">" in target:
        target = target[1:target.index(">")]
    else:
        target = target.split()[0]
    target = unquote(target.strip())
    if target.startswith("./"):
        target = target[2:]
    if target.startswith("Attachments/"):
        return target
    return None


def referenced_attachment_paths(markdown_texts: list[str]) -> set[str]:
    refs: set[str] = set()
    markdown_patterns = [
        re.compile(r"!\[[^\]]*]\(([^)\n]*Attachments/[^)\n]+)\)"),
        re.compile(r"\[[^\]]*]\(([^)\n]*Attachments/[^)\n]+)\)"),
    ]
    html_pattern = re.compile(r"<img\b[^>]*\bsrc=[\"']([^\"']*Attachments/[^\"']+)[\"'][^>]*>", re.I)
    for text in markdown_texts:
        for pattern in markdown_patterns:
            for match in pattern.finditer(text):
                ref = normalize_reference_target(match.group(1))
                if ref:
                    refs.add(ref)
        for match in html_pattern.finditer(text):
            ref = normalize_reference_target(match.group(1))
            if ref:
                refs.add(ref)
    return refs


def remove_empty_dirs(root: Path, apply: bool) -> int:
    removed = 0
    if not root.exists():
        return 0
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        current = Path(dirpath)
        if current == root:
            continue
        try:
            if not any(current.iterdir()):
                removed += 1
                if apply:
                    current.rmdir()
        except OSError:
            pass
    try:
        if root.exists() and not any(root.iterdir()):
            removed += 1
            if apply:
                root.rmdir()
    except OSError:
        pass
    return removed


def move_images_to_attachments(directory: Path, apply: bool) -> dict:
    images = directory / "images"
    attachments = directory / "Attachments"
    result = {
        "had_images": images.is_dir(),
        "files_moved": 0,
        "conflicts": 0,
        "bytes_moved": 0,
        "removed_empty_dirs": 0,
    }
    if not images.is_dir():
        return result

    for source in sorted(p for p in images.rglob("*") if p.is_file() or p.is_symlink()):
        rel = source.relative_to(images)
        dest = attachments / rel
        result["bytes_moved"] += bytes_for_path(source)
        if dest.exists():
            result["conflicts"] += 1
            continue
        result["files_moved"] += 1
        if apply:
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(dest))

    result["removed_empty_dirs"] = remove_empty_dirs(images, apply)
    return result


def clean_directory(directory: Path, apply: bool) -> dict:
    summary = {
        "directory": str(directory),
        "markdown_files": 0,
        "markdown_rewritten": 0,
        "images": {"had_images": False, "files_moved": 0, "conflicts": 0, "bytes_moved": 0, "removed_empty_dirs": 0},
        "artifacts_removed": 0,
        "artifact_bytes_removed": 0,
        "unreferenced_attachments_removed": 0,
        "unreferenced_attachment_bytes_removed": 0,
        "empty_attachment_dirs_removed": 0,
        "errors": [],
    }

    markdown_texts: list[str] = []
    for md_path in sorted(directory.glob("*.md")):
        summary["markdown_files"] += 1
        try:
            original = md_path.read_text(encoding="utf-8")
            rewritten = rewrite_markdown_references(original)
            markdown_texts.append(rewritten)
            if rewritten != original:
                summary["markdown_rewritten"] += 1
                if apply:
                    md_path.write_text(rewritten, encoding="utf-8")
        except Exception as exc:  # noqa: BLE001
            summary["errors"].append(f"{md_path.name}: {exc}")

    images_result = move_images_to_attachments(directory, apply)
    summary["images"] = images_result

    for child in sorted(directory.iterdir()):
        remove = (
            child.name == "layout.json"
            or child.name == "mineru-result.zip"
            or child.name.lower().endswith("_origin.pdf")
        )
        if not remove:
            continue
        summary["artifacts_removed"] += 1
        summary["artifact_bytes_removed"] += bytes_for_path(child)
        if apply:
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink(missing_ok=True)

    attachments = directory / "Attachments"
    refs = referenced_attachment_paths(markdown_texts)
    if attachments.is_dir():
        for file_path in sorted(p for p in attachments.rglob("*") if p.is_file() or p.is_symlink()):
            rel = "Attachments/" + file_path.relative_to(attachments).as_posix()
            if rel not in refs:
                summary["unreferenced_attachments_removed"] += 1
                summary["unreferenced_attachment_bytes_removed"] += bytes_for_path(file_path)
                if apply:
                    file_path.unlink(missing_ok=True)
        summary["empty_attachment_dirs_removed"] = remove_empty_dirs(attachments, apply)

    return summary


def main() -> int:
    args = parse_args()
    storage = args.storage.expanduser()
    directories = sorted(path.parent for path in storage.glob("*/paper-markdown-meta.json"))
    entries = [clean_directory(directory, args.apply) for directory in directories]
    totals = {
        "mode": "apply" if args.apply else "dry-run",
        "storage": str(storage),
        "directories_seen": len(entries),
        "markdown_files": sum(e["markdown_files"] for e in entries),
        "markdown_rewritten": sum(e["markdown_rewritten"] for e in entries),
        "image_dirs_seen": sum(1 for e in entries if e["images"]["had_images"]),
        "image_files_moved": sum(e["images"]["files_moved"] for e in entries),
        "image_move_conflicts": sum(e["images"]["conflicts"] for e in entries),
        "artifacts_removed": sum(e["artifacts_removed"] for e in entries),
        "artifact_bytes_removed": sum(e["artifact_bytes_removed"] for e in entries),
        "unreferenced_attachments_removed": sum(e["unreferenced_attachments_removed"] for e in entries),
        "unreferenced_attachment_bytes_removed": sum(e["unreferenced_attachment_bytes_removed"] for e in entries),
        "empty_attachment_dirs_removed": sum(e["empty_attachment_dirs_removed"] for e in entries),
        "error_count": sum(len(e["errors"]) for e in entries),
    }
    report = {"totals": totals, "entries": entries}
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(totals, ensure_ascii=False, indent=2))
    return 0 if totals["error_count"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
