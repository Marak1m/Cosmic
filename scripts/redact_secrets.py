import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


KEY_PATTERNS = [
    re.compile(r"sk-proj-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"sk-[A-Za-z0-9_\-]{20,}"),
]


def redact_text(text: str) -> str:
    redacted = text
    for pat in KEY_PATTERNS:
        redacted = pat.sub("sk-REDACTED", redacted)

    # Strip hardcoded env assignments (keep the line but blank out the value).
    redacted = re.sub(
        r'(os\.environ\[\s*["\']OPENAI_API_KEY["\']\s*\]\s*=\s*)["\'][^"\']*["\']',
        r"\1\"\"",
        redacted,
    )
    return redacted


def redact_env_example(path: Path) -> None:
    lines = path.read_text(encoding="utf-8").splitlines(keepends=True)
    out = []
    for line in lines:
        if line.startswith("OPENAI_API_KEY="):
            out.append("OPENAI_API_KEY=\n")
        else:
            out.append(line)
    path.write_text("".join(out), encoding="utf-8")


def main() -> None:
    # .env.example
    env_example = ROOT / ".env.example"
    if env_example.exists():
        redact_env_example(env_example)
        print(f"Redacted {env_example.relative_to(ROOT)}")

    # Common text/code files that may contain embedded keys.
    exts = {".ipynb", ".py", ".md"}
    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if path.name == ".env.example":
            continue
        if path.suffix.lower() not in exts:
            continue
        # Skip node_modules and venvs
        if any(part in {"node_modules", "venvs", ".git"} for part in path.parts):
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        redacted = redact_text(text)
        if redacted != text:
            path.write_text(redacted, encoding="utf-8")
            print(f"Redacted {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

