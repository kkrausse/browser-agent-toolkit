import sys

from inventory import load_items
from report import format_report


def greet(name: str) -> str:
    return f"hello, {name}"


def main(argv: list[str]) -> int:
    path = argv[1] if len(argv) > 1 else "data/items.csv"
    print(greet("pantry"))
    print(format_report(load_items(path)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
