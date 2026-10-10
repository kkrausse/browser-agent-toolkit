"""Loading the pantry inventory and computing totals."""

import csv
from dataclasses import dataclass


@dataclass
class Item:
    name: str
    quantity: int
    unit_price: float

    @property
    def value(self) -> float:
        return self.quantity * self.unit_price


def load_items(path: str) -> list[Item]:
    """Reads items from a CSV file with the columns name, quantity, unit_price."""
    items = []
    with open(path, newline="") as handle:
        for row in csv.DictReader(handle):
            items.append(Item(row["name"], int(row["quantity"]), float(row["unit_price"])))
    return items


def total_value(items: list[Item]) -> float:
    return sum(item.value for item in items)


def low_stock(items: list[Item], threshold: int = 3) -> list[Item]:
    # TODO: make the threshold configurable per item
    return [item for item in items if item.quantity < threshold]
