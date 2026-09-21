#!/usr/bin/env python3
"""Check shipped skill metadata, local Markdown links and support symlinks."""
from pathlib import Path
import re
import sys
import yaml

root = Path(__file__).resolve().parents[1] / "app/defaults/skills"
errors = []
if not root.is_dir() or not list(root.glob("*/SKILL.md")):
    sys.exit(f"No skills found at {root}")
for skill in sorted(root.glob("*/SKILL.md")):
    try:
        metadata = yaml.safe_load(skill.read_text().split("---", 2)[1])
        if metadata.get("name") != skill.parent.name:
            errors.append(f"{skill}: name must match directory")
        description = metadata.get("description")
        if not isinstance(description, str) or not 0 < len(description) <= 1024:
            errors.append(f"{skill}: description must have 1–1024 characters")
    except (ValueError, IndexError, yaml.YAMLError) as error:
        errors.append(f"{skill}: invalid frontmatter: {error}")
for path in root.rglob("*"):
    if path.is_symlink() and not path.exists():
        errors.append(f"{path}: broken symlink")
    if path.suffix != ".md" or not path.is_file():
        continue
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", path.read_text()):
        if "://" in target or target.startswith(("#", "mailto:")):
            continue
        if not (path.parent / target.split("#")[0]).exists():
            errors.append(f"{path.relative_to(root)}: missing link {target}")
if errors:
    print("\n".join(errors), file=sys.stderr)
    sys.exit(1)
print(f"Checked {len(list(root.glob('*/SKILL.md')))} skills, local links and support symlinks")
