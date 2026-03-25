import json
import os
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIR = ROOT / "notebooks" / "autogen default"


def _strip_outputs(nb: dict) -> None:
    for cell in nb.get("cells", []):
        if cell.get("cell_type") == "code":
            cell["execution_count"] = None
            cell["outputs"] = []


def _replace_llm_config(src: str) -> str:
    # Replace any `llm_config* = {...}` block with OpenAI gpt-4o config.
    lines = src.splitlines(keepends=True)
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^(\s*)(llm_config\w*)\s*=\s*\{", line)
        if m:
            indent = m.group(1)
            var = m.group(2)
            brace = 0
            # Consume until matching closing brace for the dict.
            while i < len(lines):
                brace += lines[i].count("{")
                brace -= lines[i].count("}")
                i += 1
                if brace <= 0:
                    break
            out.append(
                f"{indent}# Configure the language model (OpenAI)\n"
                f"{indent}{var} = {{\n"
                f"{indent}    \"config_list\": [\n"
                f"{indent}        {{\"model\": \"gpt-4o\", \"api_key\": os.environ.get(\"OPENAI_API_KEY\")}},\n"
                f"{indent}    ]\n"
                f"{indent}}}\n"
            )
            continue
        out.append(line)
        i += 1
    return "".join(out)


def _remove_openai_key_assignment(src: str) -> str:
    lines = src.splitlines(keepends=True)
    out: list[str] = []
    for line in lines:
        if re.match(r"^\s*os\.environ\[\s*[\"']OPENAI_API_KEY[\"']\s*\]\s*=", line):
            continue
        out.append(line)
    return "".join(out)


def _remove_leader_agent_block(src: str) -> str:
    """
    Remove agent construction blocks whose variable is `Leader` OR whose `name="Leader"`.
    This is heuristic but works for the repo's notebooks.
    """
    lines = src.splitlines(keepends=True)
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # Detect start of an agent construction assignment.
        start_match = re.match(r"^\s*(\w+)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\(", line)
        if start_match and ("Agent" in start_match.group(2) or start_match.group(2) == "ConversableAgent"):
            parens = 0
            block_lines: list[str] = []
            while i < len(lines):
                block_lines.append(lines[i])
                parens += lines[i].count("(")
                parens -= lines[i].count(")")
                i += 1
                if parens <= 0:
                    break

            block_text = "".join(block_lines)
            var_name = start_match.group(1)
            is_leader_var = var_name == "Leader"
            is_leader_named = bool(re.search(r'^\s*name\s*=\s*\"Leader\"', block_text, flags=re.M))
            if is_leader_var or is_leader_named:
                while i < len(lines) and lines[i].strip() == "":
                    i += 1
                continue

            out.extend(block_lines)
            continue
        out.append(line)
        i += 1
    return "".join(out)


def _remove_leader_from_agents_list(src: str) -> str:
    # Handle common patterns: `agents = [..., Leader, ...]`
    src = re.sub(r",\s*Leader\s*,", ", ", src)
    src = re.sub(r"\[\s*Leader\s*,", "[", src)
    src = re.sub(r",\s*Leader\s*\]", "]", src)
    src = re.sub(r"agents\s*=\s*\[([^\]]*?)\]", lambda m: "agents = [" + re.sub(r"\bLeader\b\s*,?\s*", "", m.group(1)).strip() + "]", src)
    return src


def _patch_speaker_selection(src: str) -> str:
    # If speaker selection special-cases the Leader by name, pick the first agent instead.
    src = src.replace('agent.name == "Leader"', "agent.name == groupchat.agents[0].name")
    src = src.replace("Setting speaker to Leader agent", "Setting speaker to first agent")
    # Remove Leader from coordinator prompt options when present in strings.
    src = src.replace(" and Leader", "")
    src = src.replace(", and Leader", "")
    src = src.replace(", Leader", "")
    return src


def _patch_follow_leader_language(src: str) -> str:
    src = src.replace("Follow Leader", "Collaborate with other agents")
    src = src.replace("follow Leader", "collaborate with other agents")
    src = src.replace("Follow the Leader", "Collaborate with other agents")
    src = src.replace("follow the Leader", "collaborate with other agents")
    src = src.replace("Leader's instructions", "the group's instructions")
    src = src.replace("Leader & others", "other agents")
    src = src.replace("your Leader", "your group")
    src = src.replace("the Leader", "the coordinator")
    src = src.replace("Leader agent", "coordinator agent")
    return src


def _redact_api_keys(src: str) -> str:
    # Redact any embedded OpenAI project keys in notebook text.
    return re.sub(r"sk-proj-[A-Za-z0-9_\-]{20,}", "sk-proj-REDACTED", src)


def _patch_cell_source(src: str) -> str:
    src = _redact_api_keys(src)
    src = _remove_openai_key_assignment(src)
    src = _replace_llm_config(src)
    src = _remove_leader_agent_block(src)
    src = _remove_leader_from_agents_list(src)
    src = _patch_speaker_selection(src)
    src = _patch_follow_leader_language(src)
    return src


def process_notebook(path: Path) -> None:
    nb = json.loads(path.read_text(encoding="utf-8"))
    _strip_outputs(nb)

    for cell in nb.get("cells", []):
        # Redact secrets in markdown too.
        if cell.get("cell_type") == "markdown":
            src = "".join(cell.get("source", []))
            patched = _redact_api_keys(src)
            if patched != src:
                cell["source"] = patched.splitlines(keepends=True)
            continue
        if cell.get("cell_type") != "code":
            continue
        src = "".join(cell.get("source", []))
        patched = _patch_cell_source(src)
        if patched != src:
            cell["source"] = patched.splitlines(keepends=True)

    path.write_text(json.dumps(nb, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    if not DEFAULT_DIR.exists():
        raise SystemExit(f"Missing folder: {DEFAULT_DIR}")

    nb_paths = sorted(DEFAULT_DIR.glob("*.ipynb"))
    if not nb_paths:
        raise SystemExit(f"No notebooks found in: {DEFAULT_DIR}")

    for p in nb_paths:
        process_notebook(p)
        print(f"Updated {p.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
