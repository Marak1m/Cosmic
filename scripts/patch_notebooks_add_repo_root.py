import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

SNIPPET = (
    "import sys\n"
    "from pathlib import Path\n"
    "\n"
    "# Ensure repo root is on sys.path so `from tools...` imports work from any notebook subfolder.\n"
    "_p = Path.cwd().resolve()\n"
    "for _parent in [_p, *_p.parents]:\n"
    "    if (_parent / 'tools' / 'search_tools.py').exists():\n"
    "        sys.path.insert(0, str(_parent))\n"
    "        break\n"
    "del _p, _parent\n"
)


def ensure_bootstrap_cell(nb: dict) -> bool:
    cells = nb.get("cells", [])
    if not cells:
        return False

    # If already present (exact snippet or a marker comment), skip.
    for cell in cells[:3]:
        if cell.get("cell_type") != "code":
            continue
        src = "".join(cell.get("source", []))
        if "Ensure repo root is on sys.path" in src or "tools' / 'search_tools.py" in src:
            return False

    new_cell = {
        "cell_type": "code",
        "metadata": {},
        "execution_count": None,
        "outputs": [],
        "source": [line + "\n" for line in SNIPPET.splitlines()],
    }
    nb["cells"] = [new_cell] + cells
    return True


def patch_dir(path: Path) -> None:
    for nb_path in sorted(path.glob("*.ipynb")):
        nb = json.loads(nb_path.read_text(encoding="utf-8"))
        changed = ensure_bootstrap_cell(nb)
        if changed:
            nb_path.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
            print(f"Patched {nb_path.relative_to(ROOT)}")


def main() -> None:
    # Patch the folders that rely on `tools.search_tools`.
    patch_dir(ROOT / "notebooks" / "autogen default")
    patch_dir(ROOT / "notebooks" / "autogen modified")
    patch_dir(ROOT / "notebooks" / "tasks")
    patch_dir(ROOT / "notebooks" / "misc")


if __name__ == "__main__":
    main()

