# Sample project: pantry

A tiny inventory tool, here so that codex has something to read and edit. The
files live in this browser tab's filesystem (saved in IndexedDB) and survive a
reload; "Forget saved state" on the launcher brings this sample back.

## Layout

- `src/inventory.py`: loads `data/items.csv` and computes totals
- `src/report.py`: formats the report
- `src/main.py`: entry point (`python src/main.py data/items.csv`)
- `tests/test_inventory.py`: unit tests
- `notes/todo.md`: open tasks

## Things to try

- "What does this project do?" (codex reads files with `rg`, `sed -n`, `nl -ba`, `cat`)
- "Sort the report by item name" (an edit with `apply_patch`, then a look at the result)
- `!rg -n TODO` runs a command yourself

Nothing here can be executed: this machine has a shell with file tools, but no
Python, no git and no network tools.
