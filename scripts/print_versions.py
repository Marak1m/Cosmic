#!/usr/bin/env python
"""
Utility script to list the versions of every package that is currently
installed in this virtual environment.
"""

from __future__ import annotations

import argparse
import sys
from importlib import metadata


def iter_installed_packages() -> list[tuple[str, str]]:
    """Return a sorted list of (package_name, version) tuples."""
    packages: list[tuple[str, str]] = []
    for dist in metadata.distributions():
        name = dist.metadata.get("Name") or dist.metadata.get("Summary") or dist.metadata["Name"]
        packages.append((name, dist.version))
    packages.sort(key=lambda item: item[0].lower())
    return packages


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Print all packages and their versions for the active environment.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional maximum number of packages to display.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    packages = iter_installed_packages()

    print(f"Python executable: {sys.executable}")
    print(f"Python version: {sys.version.split()[0]}")
    print("\nInstalled packages:")

    selected = packages[: args.limit] if args.limit else packages
    for name, version in selected:
        print(f"{name}=={version}")


if __name__ == "__main__":
    main()
