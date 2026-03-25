import os
import random
import re
import sys
from collections import defaultdict

import pandas as pd

import autogen
from autogen import ConversableAgent
from autogen.agentchat import GroupChat, GroupChatManager
from autogen.io import IOStream


# =========================
# Global knobs (defaults)
# =========================
T_LEADER = 7  # heartbeat frequency (default)
THETA_H = 0.8  # consistency threshold (default)
EPS_C = 0.1  # stability threshold for coverage (default)
EPS_H = 0.1  # stability threshold for consistency (default)

K_RUNS = 3  # repeats per setting (3 min, 5 ideal)
MAX_ROUNDS = 100

# Model selection
#
# Notes:
# - `o1` works with AutoGen's ChatCompletions path only if we DO NOT send `max_tokens`
#   or non-default `temperature`. This script therefore omits `temperature` for o1.
# - Use env vars to override locally without changing code.
MODEL_LEADER = os.getenv("COSMIC_LEADER_MODEL", "o1")
# Default agents to a fast/cheap model; override with COSMIC_AGENT_MODEL=o1 if you want all-o1.
MODEL_AGENT = os.getenv("COSMIC_AGENT_MODEL", "gpt-4o-mini")


def _make_llm_config(model: str) -> dict:
    cfg: dict = {"config_list": [{"model": model, "api_key": os.getenv("OPENAI_API_KEY")}]}
    # `o1` rejects non-default temperatures; keep it unset.
    if not model.startswith("o1"):
        cfg["temperature"] = 0
    return cfg

# Avoid Windows cp1252 UnicodeEncodeError when any library prints non-ASCII.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

if os.getenv("COSMIC_VERBOSE", "0") != "1":
    class _QuietIO:
        def print(self, *objects, sep: str = " ", end: str = "\n", flush: bool = False) -> None:
            return

        def input(self, prompt: str = "", *, password: bool = False) -> str:
            raise RuntimeError("Input is disabled in COSMIC sweep mode.")

    IOStream.set_global_default(_QuietIO())


# =========================
# Speaker selection state
# =========================
is_first_call = True
call_count = 0


def _normalize_day(day: str) -> str | None:
    d = (day or "").strip().lower()
    if d in {"mon", "monday"}:
        return "Monday"
    if d in {"tue", "tues", "tuesday"}:
        return "Tuesday"
    if d in {"wed", "weds", "wednesday"}:
        return "Wednesday"
    return None


def _to_minutes(time_str: str) -> int | None:
    m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*$", time_str or "")
    if not m:
        return None
    hh = int(m.group(1))
    mm = int(m.group(2))
    if hh == 24 and mm == 0:
        return 24 * 60
    if hh < 0 or hh > 23 or mm < 0 or mm > 59:
        return None
    return hh * 60 + mm


def _extract_schedule_rows(text: str) -> list[tuple[str, str, str, str, str]]:
    """
    Extracts rows of (Day, Start, End, Resource, Agent) from free-form text.
    Assumes Leader outputs CSV-like lines: Day, Start, End, Resource, Agent
    """
    rows: list[tuple[str, str, str, str, str]] = []
    for line in (text or "").splitlines():
        if "," not in line:
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 5:
            continue
        day_raw, start, end, resource, agent = parts[:5]
        day = _normalize_day(day_raw)
        if not day:
            continue
        rows.append((day, start, end, resource.strip(), agent.strip()))
    return rows


def validate_schedule(text: str) -> bool:
    """
    Minimal deterministic validator.
    Returns True if schedule is parseable, resources are not double-booked, and all agents appear at least once.
    """
    rows = _extract_schedule_rows(text)
    # If parsing fails (too few rows), treat as invalid.
    if len(rows) < 4:
        return False

    # Build absolute timeline minutes for Mon-Wed (0..3*1440).
    day_index = {"Monday": 0, "Tuesday": 1, "Wednesday": 2}

    def abs_min(day: str, t: str) -> int | None:
        tm = _to_minutes(t)
        if tm is None:
            return None
        return day_index[day] * 1440 + tm

    bookings_by_day_resource: defaultdict[tuple[str, str], list[tuple[int, int, str]]] = defaultdict(list)
    agents_present: set[str] = set()

    parsed_rows: list[tuple[str, int, int, str, str]] = []
    for day, start, end, resource_raw, agent_raw in rows:
        resource = resource_raw.strip().upper()
        if resource not in {"A", "B", "C"}:
            return False

        start_min = _to_minutes(start)
        end_min = _to_minutes(end)
        if start_min is None or end_min is None:
            return False
        # Heuristic: many outputs use "22:00 -> 00:00" to mean "22:00 -> 24:00".
        if end_min == 0 and start_min >= 12 * 60:
            end_min = 24 * 60

        start_abs = day_index[day] * 1440 + start_min
        end_abs = day_index[day] * 1440 + end_min
        if start_abs is None or end_abs is None:
            return False
        if end_abs <= start_abs:
            return False

        agent = agent_raw.strip()
        parsed_rows.append((day, start_abs, end_abs, resource, agent))

    # Check no overlaps per (day, resource).
    for day, start_abs, end_abs, resource, agent in parsed_rows:
        bookings_by_day_resource[(day, resource)].append((start_abs, end_abs, agent))
        agents_present.add(agent)

    for (_day, _resource), intervals in bookings_by_day_resource.items():
        intervals.sort(key=lambda x: x[0])
        for i in range(1, len(intervals)):
            if intervals[i][0] < intervals[i - 1][1]:
                return False

    # Require all agents A-D appear at least once.
    required_agents = {"Agent_A", "Agent_B", "Agent_C", "Agent_D"}
    if not required_agents.issubset(agents_present):
        # allow shorthand "A"/"B"/...
        shorthand_present = set()
        for a in agents_present:
            a_norm = a.strip()
            if a_norm in {"A", "B", "C", "D"}:
                shorthand_present.add(f"Agent_{a_norm}")
        if not required_agents.issubset(shorthand_present | agents_present):
            return False

    return True


def _extract_next_speaker_name(text: str) -> str | None:
    if not text:
        return None
    m = re.search(r"(?:Who speaks next|Next speaker)\s*:\s*([A-Za-z0-9_]+)", text, re.IGNORECASE)
    if not m:
        return None
    return m.group(1).strip()


def custom_speaker_selection_func(last_speaker, groupchat):
    global is_first_call, call_count, T_LEADER

    if is_first_call:
        is_first_call = False
        for agent in groupchat.agents:
            if agent.name == "Leader":
                return agent
        return None

    call_count += 1
    if T_LEADER > 0 and call_count % T_LEADER == 0:
        for agent in groupchat.agents:
            if agent.name == "Leader":
                return agent

    last_message = groupchat.messages[-1] if groupchat.messages else {}
    wanted = _extract_next_speaker_name(last_message.get("content", ""))
    if wanted:
        for agent in groupchat.agents:
            if agent.name == wanted:
                return agent

    # Fallback: round-robin by role
    order = ["Leader", "Agent_A", "Agent_B", "Agent_C", "Agent_D"]
    last_name = getattr(last_speaker, "name", None)
    if last_name in order:
        next_name = order[(order.index(last_name) + 1) % len(order)]
    else:
        next_name = "Leader"
    for agent in groupchat.agents:
        if agent.name == next_name:
            return agent
    return None


def _require_env():
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Set it in your environment before running this script (do not commit keys)."
        )


def run_episode(seed: int, T_leader: int, theta_h: float, eps_c: float, eps_h: float):
    global is_first_call, call_count, T_LEADER, THETA_H, EPS_C, EPS_H

    _require_env()
    random.seed(seed)

    # Set globals used by speaker selection + leader prompt.
    T_LEADER = int(T_leader)
    THETA_H = float(theta_h)
    EPS_C = float(eps_c)
    EPS_H = float(eps_h)

    # Reset globals for speaker selection.
    is_first_call = True
    call_count = 0

    llm_config_leader = _make_llm_config(MODEL_LEADER)
    llm_config_agent = _make_llm_config(MODEL_AGENT)

    initial_message = (
        "Leader: Assign tasks now. Agents A,B,C,D: Present your constraints. Start scheduling.\n\n"
        "HORIZON: Monday–Wednesday, 24h clock.\n"
        "RESOURCES: A, B, C.\n"
        "GLOBAL RULE: At any time, a resource can be used by at most one agent.\n\n"
        "AGENT A: Use Resource A then B in sequence, Monday–Wednesday 08:00–16:00, must finish within 3 days.\n"
        "AGENT B: Needs B and C simultaneously, prefers 22:00–06:00, must finish within 2 days.\n"
        "AGENT C: Needs Resource A for 12 hours total, flexible, but avoid A’s maintenance window Tue 12:00–16:00.\n"
        "AGENT D: Needs Resource C for urgent 2-hour blocks arriving daily; may preempt others but not within first 30 minutes of another agent’s block.\n\n"
        "OUTPUT FORMAT (required): Provide final schedule as CSV rows with columns:\n"
        "Day, Start, End, Resource, Agent\n"
        "Use day names exactly: Monday, Tuesday, Wednesday.\n"
        "Use 24h times HH:MM.\n"
        "IMPORTANT: Do NOT use rows that cross midnight; split at 24:00 and continue on the next day.\n"
        "Use 24:00 only as an end time (midnight). Do not use 00:00 as an end time for late-night intervals.\n"
        "All agents: Keep replies concise (<= 8 lines), avoid repeating the full prompt.\n"
        "Then provide a checklist confirming each constraint is satisfied.\n"
    )

    common_agent_footer = (
        "Work fast and converge to a correct schedule.\n"
        "Use plain ASCII text only (no emojis).\n"
        "Be concise: <= 8 lines.\n"
        "Do not restate the full problem.\n"
        "Always end your message with: Who speaks next: <AgentName>\n"
        "Valid names: Leader, Agent_A, Agent_B, Agent_C, Agent_D.\n"
    )

    user_proxy = autogen.UserProxyAgent(
        name="User_proxy",
        system_message=(
            "A human admin. Do not speak unless needed. Terminate the chat only when Leader includes 'TERMINATE'."
        ),
        code_execution_config=False,
        human_input_mode="NEVER",
        is_termination_msg=lambda x: "TERMINATE" in (x.get("content", "") or ""),
        llm_config=llm_config_leader,
    )

    leader_system_message = (
        "You are the Leader.\n"
        "You oversee 4 agents (A,B,C,D) who must schedule multiple resources (A,B,C) with constraints.\n"
        "You do not solve directly, but gather proposals, resolve conflicts, reassign tasks, and finalize a feasible schedule.\n\n"
        "Be concise. Do not repeat the full task statement.\n\n"
        "TERMINATION POLICY (must follow):\n"
        "- Maintain a checklist of required constraints and subtasks.\n"
        "- Every time you speak, estimate Coverage C in [0,1] = fraction of constraints satisfied by the current proposed schedule.\n"
        "- Every time you speak, estimate Consistency H in [0,1] = whether the schedule violates any constraints (1=no violations found; 0=severe violations).\n"
        f"- Stability holds if |C - C_prev| <= {EPS_C} and |H - H_prev| <= {EPS_H}.\n"
        f"- You may say TERMINATE only if C == 1 AND H >= {THETA_H} AND stability holds.\n\n"
        "IMPORTANT: At the end of every message, output a single JSON line exactly in this format:\n"
        '{"C": <float>, "H": <float>, "stable": <true/false>, "terminate_allowed": <true/false>}\n'
        "Then choose who speaks next (unless you TERMINATE).\n"
        "When you TERMINATE, include the final schedule + checklist in the same message as TERMINATE.\n"
        "Use plain ASCII text only (no emojis).\n"
        "Always end your message with: Who speaks next: <AgentName> (unless you TERMINATE).\n"
        "Valid names: Leader, Agent_A, Agent_B, Agent_C, Agent_D.\n"
    )

    Leader = ConversableAgent(name="Leader", system_message=leader_system_message, llm_config=llm_config_leader)
    AgentA = ConversableAgent(
        name="Agent_A",
        system_message=(
            "You are Agent A.\n"
            "You must schedule Resource A then B in sequence within Monday–Wednesday 08:00–16:00 and finish within 3 days.\n"
            "Cooperate with others and follow the Leader.\n" + common_agent_footer
        ),
        llm_config=llm_config_agent,
    )
    AgentB = ConversableAgent(
        name="Agent_B",
        system_message=(
            "You are Agent B.\n"
            "You need Resources B and C simultaneously, prefer 22:00–06:00, and must finish within 2 days.\n"
            "Your schedule depends on Agent A's output.\n"
            "Cooperate with others and follow the Leader.\n" + common_agent_footer
        ),
        llm_config=llm_config_agent,
    )
    AgentC = ConversableAgent(
        name="Agent_C",
        system_message=(
            "You are Agent C.\n"
            "You need Resource A for 12 hours total, flexible, but avoid A’s maintenance Tue 12:00–16:00.\n"
            "Cooperate with others and follow the Leader.\n" + common_agent_footer
        ),
        llm_config=llm_config_agent,
    )
    AgentD = ConversableAgent(
        name="Agent_D",
        system_message=(
            "You are Agent D.\n"
            "You need Resource C for urgent 2-hour blocks arriving daily; you have high priority.\n"
            "Cooperate with others and follow the Leader.\n" + common_agent_footer
        ),
        llm_config=llm_config_agent,
    )

    agents = [Leader, AgentA, AgentB, AgentC, AgentD, user_proxy]

    group_chat = GroupChat(
        agents=agents,
        messages=[],
        max_round=MAX_ROUNDS,
        speaker_selection_method=custom_speaker_selection_func,
    )
    manager = GroupChatManager(
        groupchat=group_chat,
        llm_config=llm_config_leader,
        is_termination_msg=lambda x: "TERMINATE" in (x.get("content", "") or ""),
        code_execution_config=False,
    )

    user_proxy.initiate_chat(manager, message=initial_message, silent=True)

    final_text = ""
    for msg in reversed(group_chat.messages):
        content = msg.get("content", "") or ""
        if "TERMINATE" in content and msg.get("name") == "Leader":
            final_text = content
            break

    terminated = bool(final_text)
    valid = validate_schedule(final_text) if terminated else False
    score = 100 if (terminated and valid) else 0
    messages_count = len(group_chat.messages)
    failure = int((not terminated) or (not valid))

    return {"score": score, "messages": messages_count, "failure": failure}


def aggregate(setting_name, results):
    return {
        "Setting": setting_name,
        "Score": sum(r["score"] for r in results) / len(results),
        "Messages": sum(r["messages"] for r in results) / len(results),
        "Failures": sum(r["failure"] for r in results),
    }


def _safe_run_episode(*, seed: int, T_leader: int, theta_h: float, eps_c: float, eps_h: float):
    try:
        return run_episode(seed=seed, T_leader=T_leader, theta_h=theta_h, eps_c=eps_c, eps_h=eps_h)
    except Exception:
        return {"score": 0, "messages": 0, "failure": 1}


def run_sweep():
    rows = []

    # sweep theta_H
    for th in [0.7, 0.8, 0.9]:
        res = []
        for i in range(K_RUNS):
            print(f"[theta_H={th}] run {i+1}/{K_RUNS}")
            res.append(_safe_run_episode(seed=i, T_leader=7, theta_h=th, eps_c=0.1, eps_h=0.1))
        rows.append(aggregate(f"theta_H={th}", res))

    # sweep eps
    for eps in [0.05, 0.1, 0.2]:
        res = []
        for i in range(K_RUNS):
            print(f"[eps_C=eps_H={eps}] run {i+1}/{K_RUNS}")
            res.append(_safe_run_episode(seed=i, T_leader=7, theta_h=0.8, eps_c=eps, eps_h=eps))
        rows.append(aggregate(f"eps_C=eps_H={eps}", res))

    # sweep T_leader
    for tl in [5, 7, 9]:
        res = []
        for i in range(K_RUNS):
            print(f"[T_leader={tl}] run {i+1}/{K_RUNS}")
            res.append(_safe_run_episode(seed=i, T_leader=tl, theta_h=0.8, eps_c=0.1, eps_h=0.1))
        rows.append(aggregate(f"T_leader={tl}", res))

    df = pd.DataFrame(rows)
    out_path = "termination_sensitivity.csv"
    df.to_csv(out_path, index=False)
    print(df.to_string(index=False))
    print(f"\nWrote {out_path}")
    return df


if __name__ == "__main__":
    run_sweep()
